import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  DAEMON_DRIFT_HEAL_RETRY_MS,
  type DaemonDriftHealOptions,
  healDaemonDrift,
} from "./drift-heal.js";

const OLDER = "0.1.0-alpha.90";
const CLI = "0.1.0-alpha.92";
const MINUTE_MS = 60_000;
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function harness(
  launcher: { runtimeVersion: string; apiUrl?: string } | null = { runtimeVersion: OLDER },
) {
  const root = mkdtempSync(join(tmpdir(), "prim-drift-heal-"));
  temporaryRoots.push(root);
  const configDir = join(root, "config");
  const dataHome = join(root, "data");
  mkdirSync(configDir, { mode: 0o700 });
  const unref = vi.fn();
  const spawnProcess = vi.fn(() => ({ unref }));
  const state = { clock: 1_000_000 };
  const marker = join(configDir, "daemon-drift-heal.json");
  const env = { PRIM_CONFIG_DIR: configDir, XDG_DATA_HOME: dataHome };
  const options = (overrides: Partial<DaemonDriftHealOptions> = {}): DaemonDriftHealOptions => ({
    platform: "darwin",
    env,
    homeDir: join(root, "home"),
    cliVersion: CLI,
    primEntry: "/pkg/dist/index.js",
    nodeEntry: "/usr/bin/node",
    nowMs: () => state.clock,
    selectedLauncher: () => launcher,
    spawnProcess,
    ...overrides,
  });
  return { configDir, dataHome, env, marker, options, spawnProcess, state, unref };
}

describe("healDaemonDrift", () => {
  it("starts exactly one detached, local ensure for an older launcher and records it", () => {
    const h = harness();

    expect(healDaemonDrift(h.options())).toBe(true);

    expect(h.spawnProcess).toHaveBeenCalledOnce();
    expect(h.spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/index.js", "daemon", "ensure"],
      { detached: true, stdio: "ignore" },
    );
    expect(h.unref).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(h.marker, "utf8"))).toEqual({
      attemptedAt: 1_000_000,
      fromVersion: OLDER,
      toVersion: CLI,
    });
    expect(statSync(h.marker).mode & 0o777).toBe(0o600);
  });

  it.each([
    { name: "an equal launcher", launcher: CLI, cli: CLI },
    { name: "a newer launcher", launcher: "0.1.0-alpha.93", cli: CLI },
    { name: "an unparseable launcher", launcher: "nightly", cli: CLI },
    { name: "an unparseable CLI", launcher: OLDER, cli: "dev" },
    { name: "an unknown CLI version", launcher: OLDER, cli: null },
  ])("never downgrades or guesses from $name", ({ launcher, cli }) => {
    const h = harness({ runtimeVersion: launcher });

    expect(healDaemonDrift(h.options({ cliVersion: cli }))).toBe(false);

    expect(h.spawnProcess).not.toHaveBeenCalled();
    expect(existsSync(h.marker)).toBe(false);
  });

  it("does nothing without a supervised launcher", () => {
    const h = harness(null);

    expect(healDaemonDrift(h.options())).toBe(false);
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });

  it.each(["linux", "win32"] as const)("is a no-op on unsupervised %s", (platform) => {
    const h = harness();

    expect(healDaemonDrift(h.options({ platform }))).toBe(false);
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });

  it("honors both explicit-stop markers", () => {
    const current = harness();
    writeFileSync(join(current.configDir, "daemon.disabled"), "disabled by `prim daemon stop`\n");
    const legacy = harness();
    mkdirSync(join(legacy.dataHome, "prim"), { recursive: true });
    writeFileSync(join(legacy.dataHome, "prim", "daemon.disabled"), "disabled\n");

    expect(healDaemonDrift(current.options())).toBe(false);
    expect(healDaemonDrift(legacy.options())).toBe(false);

    expect(current.spawnProcess).not.toHaveBeenCalled();
    expect(legacy.spawnProcess).not.toHaveBeenCalled();
  });

  it("never retargets the daemon at another deployment", () => {
    const h = harness();
    const staging = { ...h.env, PRIM_API_URL: "https://staging.test" };
    expect(healDaemonDrift(h.options({ env: staging }))).toBe(false);
    expect(h.spawnProcess).not.toHaveBeenCalled();

    const pinned = harness({ runtimeVersion: OLDER, apiUrl: "https://staging.test" });
    const sameStaging = { ...pinned.env, PRIM_API_URL: " https://staging.test/ " };
    expect(healDaemonDrift(pinned.options({ env: sameStaging }))).toBe(true);
    // An explicit default URL names the same deployment as an unset one.
    const defaulted = harness({ runtimeVersion: OLDER, apiUrl: "https://api.getprimitive.ai" });
    expect(healDaemonDrift(defaulted.options())).toBe(true);
  });

  it("rate-limits one target version per hour but never holds back a newer one", () => {
    const h = harness();
    expect(DAEMON_DRIFT_HEAL_RETRY_MS).toBe(60 * MINUTE_MS);

    expect(healDaemonDrift(h.options())).toBe(true);
    h.state.clock += DAEMON_DRIFT_HEAL_RETRY_MS - MINUTE_MS;
    expect(healDaemonDrift(h.options())).toBe(false);
    expect(h.spawnProcess).toHaveBeenCalledTimes(1);

    h.state.clock += MINUTE_MS;
    expect(healDaemonDrift(h.options())).toBe(true);
    expect(healDaemonDrift(h.options({ cliVersion: "0.1.0-alpha.93" }))).toBe(true);
    expect(healDaemonDrift(h.options({ cliVersion: "0.1.0-alpha.93" }))).toBe(false);
    expect(h.spawnProcess).toHaveBeenCalledTimes(3);
  });

  it("treats a malformed or future record as stale and re-anchors it", () => {
    const h = harness();
    writeFileSync(h.marker, "not json\n");
    expect(healDaemonDrift(h.options())).toBe(true);

    writeFileSync(
      h.marker,
      JSON.stringify({
        attemptedAt: h.state.clock + MINUTE_MS,
        fromVersion: OLDER,
        toVersion: CLI,
      }),
    );
    expect(healDaemonDrift(h.options())).toBe(true);
    expect(JSON.parse(readFileSync(h.marker, "utf8")).attemptedAt).toBe(h.state.clock);
    expect(healDaemonDrift(h.options())).toBe(false);
    expect(h.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("does not spawn an attempt it cannot record", () => {
    const h = harness();
    mkdirSync(join(h.marker, "occupied"), { recursive: true });

    expect(healDaemonDrift(h.options())).toBe(false);
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });

  it("records a failed spawn so the next command does not retry it", () => {
    const h = harness();
    const spawnProcess = vi.fn(() => {
      throw new Error("spawn failed");
    });

    expect(healDaemonDrift(h.options({ spawnProcess }))).toBe(false);
    expect(healDaemonDrift(h.options({ spawnProcess }))).toBe(false);
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("fails soft without an entry or with an unusable config root", () => {
    const h = harness();

    expect(healDaemonDrift(h.options({ primEntry: null }))).toBe(false);
    expect(existsSync(h.marker)).toBe(false);
    expect(healDaemonDrift(h.options({ env: { PRIM_CONFIG_DIR: "/tmp/prim\u0000bad" } }))).toBe(
      false,
    );
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });
});
