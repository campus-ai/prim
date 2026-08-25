import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import { daemonRequest } from "./client.js";
import { type LaunchctlResult, bootoutMacDaemon } from "./launchd.js";

// `stopVerifiedLegacyDaemon` (the default `migrateLegacy`) calls `daemonRequest`
// directly, so it is the one lifecycle seam the main suite always mocks away.
// Mock only the socket here so the real pidfile read, pid verification, SIGTERM,
// and deadline poll run against genuine child processes.
vi.mock("./client.js", () => ({ daemonRequest: vi.fn() }));

const mockedRequest = vi.mocked(daemonRequest);
const ABSENT: LaunchctlResult = { status: 113, stdout: "", stderr: "", timedOut: false };

const children: ChildProcess[] = [];
const roots: string[] = [];

/** A real detached-daemon stand-in that terminates on the default SIGTERM. */
function spawnLegacy(): number {
  const child = spawn(process.execPath, ["-e", "setInterval(() => undefined, 1000);"], {
    stdio: "ignore",
  });
  child.on("error", () => undefined);
  children.push(child);
  if (child.pid === undefined) throw new Error("failed to spawn legacy stand-in");
  return child.pid;
}

/** A stand-in that ignores SIGTERM. Resolves `ready` only once the handler is
 *  installed, so the test never signals before the trap is armed. */
function spawnSigtermTrap(): { pid: number; ready: Promise<void> } {
  const child = spawn(
    process.execPath,
    [
      "-e",
      "process.on('SIGTERM', () => undefined); process.stdout.write('ready\\n'); setInterval(() => undefined, 1000);",
    ],
    { stdio: ["ignore", "pipe", "ignore"] },
  );
  child.on("error", () => undefined);
  children.push(child);
  if (child.pid === undefined) throw new Error("failed to spawn legacy stand-in");
  const ready = new Promise<void>((resolve) => child.stdout?.once("data", () => resolve()));
  return { pid: child.pid, ready };
}

/** Temp HOME with a `.config/prim/daemon.pid`, unless `pidfile` is omitted. */
function seedHome(pidfile?: string): string {
  const root = mkdtempSync(join(tmpdir(), "prim-legacy-"));
  roots.push(root);
  const home = join(root, "home");
  mkdirSync(join(home, ".config", "prim"), { recursive: true });
  if (pidfile !== undefined) {
    writeFileSync(join(home, ".config", "prim", "daemon.pid"), pidfile);
  }
  return home;
}

/** launchd reports the label absent, and a socket owner responds — the exact
 *  condition under which bootout runs the verified legacy migration. */
function absentWithLegacyOwner(home: string, socketPid: number) {
  return {
    homeDir: home,
    uid: 501,
    label: `ai.getprimitive.test-legacy-${process.pid}-${roots.length}`,
    env: { XDG_DATA_HOME: join(home, "..", "data") },
    runner: () => ABSENT,
    // The post-stop probe must become absent once the real stand-in exits.
    inspectDaemon: async () => (isAlive(socketPid) ? { pid: socketPid } : null),
  };
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function waitUntilDead(pid: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (isAlive(pid) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

afterEach(() => {
  mockedRequest.mockReset();
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("bootout verified legacy migration (default migrateLegacy)", () => {
  it("SIGTERMs a pid-verified legacy owner and reports it stopped", async () => {
    const pid = spawnLegacy();
    const home = seedHome(`${pid}\n`);
    mockedRequest.mockResolvedValue({ pid });

    const result = await bootoutMacDaemon(absentWithLegacyOwner(home, pid));

    expect(result.legacyStopped).toBe(true);
    await waitUntilDead(pid);
    expect(isAlive(pid)).toBe(false);
  });

  it("refuses to signal when the socket pid disagrees with the pidfile", async () => {
    const pid = spawnLegacy();
    const home = seedHome(`${pid}\n`);
    mockedRequest.mockResolvedValue({ pid: pid + 1 });

    await expect(bootoutMacDaemon(absentWithLegacyOwner(home, pid))).rejects.toThrow(
      "pid cannot be verified",
    );
    expect(isAlive(pid)).toBe(true);
  });

  it("refuses to signal a responder that has no verifiable pidfile", async () => {
    const pid = spawnLegacy();
    const home = seedHome();
    mockedRequest.mockResolvedValue({ pid });

    await expect(bootoutMacDaemon(absentWithLegacyOwner(home, pid))).rejects.toThrow(
      "no verifiable pidfile",
    );
    expect(isAlive(pid)).toBe(true);
  });

  it("throws when a verified owner ignores SIGTERM past the deadline", async () => {
    const { pid, ready } = spawnSigtermTrap();
    await ready;
    const home = seedHome(`${pid}\n`);
    mockedRequest.mockResolvedValue({ pid });
    let clock = 0;
    const nowMs = () => clock;
    const sleep = async (ms: number) => {
      clock += ms;
    };

    await expect(
      bootoutMacDaemon({ ...absentWithLegacyOwner(home, pid), nowMs, sleep }),
    ).rejects.toThrow("did not stop before the lifecycle deadline");
    expect(isAlive(pid)).toBe(true);
  });
});
