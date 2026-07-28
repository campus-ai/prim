import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import * as launchd from "./launchd.js";

const integrationIt =
  process.platform === "darwin" && process.env.PRIM_LAUNCHD_INTEGRATION === "1" ? it : it.skip;
type Identity = { pid: number; version?: string; launchRevision?: string };

function xml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

async function exerciseMainMigration(round: number): Promise<void> {
  const uid = process.getuid?.();
  if (uid === undefined) throw new Error("cannot determine uid for launchd integration test");
  const dir = mkdtempSync(join(tmpdir(), "prim-launchd-integration-"));
  const homeDir = join(dir, "home");
  const label = `ai.getprimitive.prim.integration.${randomUUID()}`;
  const paths = launchd.launchdPaths({ label, uid, homeDir });
  const fixturePath = join(dir, "daemon.cjs");
  const markerPath = join(dir, "identity.json");
  const pids = new Set<number>();
  const operations: string[] = [];
  const bootstrapStatuses: (number | null)[] = [];
  let retiringPid: number | undefined;
  let bootoutWaited = false;
  const identity = (): Identity | null => {
    try {
      const value = JSON.parse(readFileSync(markerPath, "utf8")) as Identity;
      if (!Number.isInteger(value.pid) || value.pid <= 0 || !alive(value.pid)) return null;
      pids.add(value.pid);
      return value;
    } catch {
      return null;
    }
  };
  const runner: launchd.LaunchctlRunner = (args, timeoutMs) => {
    const result = launchd.runLaunchctl(args, timeoutMs);
    if (args[0] !== "print") {
      operations.push(args[0]);
      if (args[0] === "bootstrap") bootstrapStatuses.push(result.status);
      if (args[0] === "bootout" && retiringPid) bootoutWaited ||= !alive(retiringPid);
    }
    return result;
  };
  const options = {
    label,
    uid,
    homeDir,
    env: { XDG_DATA_HOME: join(dir, "xdg") },
    daemonSource: fixturePath,
    statuslineSource: null,
    runner,
    inspectDaemon: async () => identity(),
  };
  try {
    mkdirSync(join(homeDir, "Library", "LaunchAgents"), { recursive: true });
    writeFileSync(
      fixturePath,
      `const fs = require("node:fs");
const marker = ${JSON.stringify(markerPath)};
fs.writeFileSync(marker, JSON.stringify({pid: process.pid, version: process.env.PRIM_RUNTIME_VERSION, launchRevision: process.env.PRIM_LAUNCH_REVISION}));
process.on("SIGTERM", () => setTimeout(() => process.exit(0), 750));
setInterval(() => {}, 1000);
`,
    );
    const oldVersion = `0.0.${String(round)}`;
    writeFileSync(
      paths.plistPath,
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>Label</key><string>${label}</string>
<key>ProgramArguments</key><array><string>${xml(process.execPath)}</string><string>${xml(fixturePath)}</string></array>
<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>
<key>WorkingDirectory</key><string>${xml(homeDir)}</string>
<key>EnvironmentVariables</key><dict><key>PRIM_RUNTIME_VERSION</key><string>${oldVersion}</string></dict>
</dict></plist>
`,
      { mode: 0o600 },
    );
    const seeded = launchd.runLaunchctl(["bootstrap", paths.domainTarget, paths.plistPath]);
    expect(seeded.status, seeded.stderr).toBe(0);
    await expect
      .poll(() => identity()?.version, { timeout: 15_000, interval: 50 })
      .toBe(oldVersion);
    const old = identity() as Identity;
    retiringPid = old.pid;
    const migratedVersion = `1.0.${String(round)}`;
    const migrated = await launchd.ensureMacDaemon({ ...options, version: migratedVersion });
    const first = identity();
    expect(migrated).toMatchObject({ state: "running", action: "reload" });
    expect(first).toMatchObject({ version: migratedVersion });
    expect(first?.launchRevision).toMatch(/^[a-f0-9]{64}$/u);
    expect(first?.pid).not.toBe(old.pid);
    expect(operations.filter((operation) => operation === "bootout")).toHaveLength(1);
    expect(bootstrapStatuses.at(-1)).toBe(0);
    expect(bootstrapStatuses.includes(5) || bootoutWaited).toBe(true);
    retiringPid = undefined;
    operations.length = 0;
    const upgradedVersion = `1.1.${String(round)}`;
    const upgraded = await launchd.ensureMacDaemon({ ...options, version: upgradedVersion });
    const second = identity();
    expect([upgraded.state, upgraded.action]).toEqual(["running", "kickstart"]);
    expect(operations).toEqual(["kickstart"]);
    expect(second).toMatchObject({ version: upgradedVersion });
    expect(second?.launchRevision).not.toBe(first?.launchRevision);
    expect(second?.pid).not.toBe(first?.pid);

    operations.length = 0;
    const stable = await launchd.ensureMacDaemon({ ...options, version: upgradedVersion });
    expect(stable.state).toBe("running");
    expect(stable.action).toBe("none");
    expect(stable.runtimeChanged).toBe(false);
    expect(operations).toEqual([]);
  } finally {
    await launchd
      .bootoutMacDaemon({
        ...options,
        runner: launchd.runLaunchctl,
        migrateLegacy: async () => false,
      })
      .catch((error: unknown) => expect.fail(`cleanup failed; preserved ${dir}: ${String(error)}`));
    expect(launchd.runLaunchctl(["print", paths.serviceTarget]).status, `preserved ${dir}`).toBe(
      113,
    );
    expect([...pids].filter(alive), dir).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  }
}

integrationIt(
  "converges repeated released-layout migrations and routine upgrades",
  async () => {
    for (const round of [1, 2]) await exerciseMainMigration(round);
  },
  120_000,
);
