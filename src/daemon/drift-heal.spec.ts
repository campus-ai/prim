import { execFileSync, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "tsup";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  DAEMON_DRIFT_HEAL_ENV,
  DAEMON_DRIFT_HEAL_RETRY_MS,
  type DaemonDriftHealOptions,
  healDaemonDrift,
} from "./drift-heal.js";
import { type LaunchctlResult, type SelectedDaemonLauncher, ensureMacDaemon } from "./launchd.js";

const OLDER = "0.1.0-alpha.90";
const CLI = "0.1.0-alpha.92";
const MINUTE_MS = 60_000;
const EUID = process.geteuid?.() ?? 501;
const INSTALLED_ROOT = "/opt/homebrew/lib/node_modules/@primitive.ai/prim";
const temporaryRoots: string[] = [];

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  temporaryRoots.push(root);
  return root;
}

function fakeSpawn() {
  const unref = vi.fn();
  const spawnProcess = vi.fn(() => ({ once: vi.fn(), unref }));
  return { spawnProcess, unref };
}

function harness(launcher: Partial<SelectedDaemonLauncher> | null = {}) {
  const root = temporaryRoot("prim-drift-heal-");
  const configDir = join(root, "config");
  const dataHome = join(root, "data");
  mkdirSync(configDir, { mode: 0o700 });
  const { spawnProcess, unref } = fakeSpawn();
  const state = { clock: 1_000_000 };
  const marker = join(configDir, "daemon-drift-heal.json");
  const claim = join(configDir, "daemon-drift-heal.lock");
  const env = { PRIM_CONFIG_DIR: configDir, XDG_DATA_HOME: dataHome };
  const selected = launcher && {
    runtimeVersion: OLDER,
    ownerUid: EUID,
    runnable: true,
    ...launcher,
  };
  const options = (overrides: Partial<DaemonDriftHealOptions> = {}): DaemonDriftHealOptions => ({
    platform: "darwin",
    env,
    homeDir: join(root, "home"),
    cliVersion: CLI,
    packageRoot: INSTALLED_ROOT,
    euid: EUID,
    primEntry: "/pkg/dist/index.js",
    nodeEntry: "/usr/bin/node",
    nowMs: () => state.clock,
    selectedLauncher: () => selected,
    launchAgentRunsConfigRoot: () => true,
    spawnProcess,
    ...overrides,
  });
  return { claim, configDir, dataHome, env, marker, options, spawnProcess, state, unref };
}

describe("healDaemonDrift", () => {
  it("starts exactly one detached, local ensure for an older launcher and records it", () => {
    const h = harness();

    expect(healDaemonDrift(h.options())).toBe(true);

    expect(h.spawnProcess).toHaveBeenCalledOnce();
    expect(h.spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/index.js", "daemon", "ensure"],
      expect.objectContaining({ detached: true, stdio: "ignore" }),
    );
    expect(h.unref).toHaveBeenCalledOnce();
    expect(JSON.parse(readFileSync(h.marker, "utf8"))).toEqual({
      attemptedAt: 1_000_000,
      fromVersion: OLDER,
      toVersion: CLI,
    });
    expect(statSync(h.marker).mode & 0o777).toBe(0o600);
    expect(existsSync(h.claim)).toBe(false);
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

  it("restages a launcher at this CLI's version that can no longer run", () => {
    // A heal can leave the daemon newer than the pinned hook runtime; once its
    // node is deleted, SessionStart's ensure refuses to downgrade it, so only
    // an ensure at the launcher's own version can repair it.
    const stranded = harness({ runtimeVersion: CLI, runnable: false });
    expect(healDaemonDrift(stranded.options())).toBe(true);
    expect(stranded.spawnProcess).toHaveBeenCalledOnce();

    const newer = harness({ runtimeVersion: "0.1.0-alpha.93", runnable: false });
    expect(healDaemonDrift(newer.options())).toBe(false);
    expect(newer.spawnProcess).not.toHaveBeenCalled();
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

  it(`turns off entirely under ${DAEMON_DRIFT_HEAL_ENV}=0`, () => {
    const h = harness();

    expect(healDaemonDrift(h.options({ env: { ...h.env, [DAEMON_DRIFT_HEAL_ENV]: "0" } }))).toBe(
      false,
    );
    expect(healDaemonDrift(h.options({ env: { ...h.env, [DAEMON_DRIFT_HEAL_ENV]: "1" } }))).toBe(
      true,
    );
    expect(h.spawnProcess).toHaveBeenCalledOnce();
  });

  it.each([
    ["a git checkout", "/Users/someone/src/prim"],
    ["a dist build in a worktree", "/tmp/worktrees/prim-feature"],
    ["an unresolvable package", null],
  ])("never heals from %s", (_label, packageRoot) => {
    const h = harness();

    expect(healDaemonDrift(h.options({ packageRoot }))).toBe(false);
    expect(h.spawnProcess).not.toHaveBeenCalled();
  });

  it.each([
    ["a global install", "/usr/local/lib/node_modules/@primitive.ai/prim"],
    ["an npx cache", "/Users/someone/.npm/_npx/0123abcd/node_modules/@primitive.ai/prim"],
  ])("heals from %s", (_label, packageRoot) => {
    expect(healDaemonDrift(harness().options({ packageRoot }))).toBe(true);
  });

  it("never heals as root or over another account's launcher", () => {
    const root = harness({ ownerUid: 0 });
    expect(healDaemonDrift(root.options({ euid: 0 }))).toBe(false);

    const foreign = harness({ ownerUid: EUID + 1 });
    expect(healDaemonDrift(foreign.options())).toBe(false);

    expect(root.spawnProcess).not.toHaveBeenCalled();
    expect(foreign.spawnProcess).not.toHaveBeenCalled();
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

  it("never retargets launchd at another config root's launcher", () => {
    const h = harness();

    expect(healDaemonDrift(h.options({ launchAgentRunsConfigRoot: () => false }))).toBe(false);
    expect(h.spawnProcess).not.toHaveBeenCalled();
    expect(existsSync(h.marker)).toBe(false);
  });

  it("rate-limits any attempt for an hour, whatever version it targets", () => {
    const h = harness();
    const NEWER = "0.1.0-alpha.93";
    expect(DAEMON_DRIFT_HEAL_RETRY_MS).toBe(60 * MINUTE_MS);

    expect(healDaemonDrift(h.options())).toBe(true);
    // Two installed CLIs (say a global install and an npx cache) must not
    // alternate past the window while each ensure fails before it rewrites
    // the launcher.
    h.state.clock += DAEMON_DRIFT_HEAL_RETRY_MS - MINUTE_MS;
    expect(healDaemonDrift(h.options({ cliVersion: NEWER }))).toBe(false);
    expect(healDaemonDrift(h.options())).toBe(false);
    expect(h.spawnProcess).toHaveBeenCalledTimes(1);

    h.state.clock += MINUTE_MS;
    expect(healDaemonDrift(h.options({ cliVersion: NEWER }))).toBe(true);
    expect(healDaemonDrift(h.options())).toBe(false);
    expect(JSON.parse(readFileSync(h.marker, "utf8"))).toMatchObject({ toVersion: NEWER });
    expect(h.spawnProcess).toHaveBeenCalledTimes(2);
  });

  it("starts nothing while another command holds the claim, and never waits for it", () => {
    const h = harness();
    const owner = join(h.claim, "owner.json");
    mkdirSync(h.claim);
    writeFileSync(owner, JSON.stringify({ pid: process.pid, nonce: "held", createdAt: 0 }));

    const startedAt = Date.now();
    expect(healDaemonDrift(h.options())).toBe(false);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    expect(h.spawnProcess).not.toHaveBeenCalled();
    expect(existsSync(h.marker)).toBe(false);
    expect(readFileSync(owner, "utf8")).toContain("held");

    // A claim whose owner died mid-claim is recovered rather than permanent.
    const { pid } = spawnSync(process.execPath, ["--eval", ""]);
    writeFileSync(owner, JSON.stringify({ pid, nonce: "dead", createdAt: 0 }));
    expect([healDaemonDrift(h.options()), healDaemonDrift(h.options())]).toContain(true);
    expect(h.spawnProcess).toHaveBeenCalledOnce();
    expect(existsSync(h.claim)).toBe(false);
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

  it("ignores an oversized record rather than reading it", () => {
    const h = harness();
    // A current, otherwise valid attempt that would rate-limit this heal, but
    // padded past the 1 KiB bound: it must read as absent.
    const recent = JSON.stringify({
      attemptedAt: h.state.clock,
      fromVersion: OLDER,
      toVersion: CLI,
    });
    writeFileSync(h.marker, `${recent}${" ".repeat(1_024)}\n`);

    expect(healDaemonDrift(h.options())).toBe(true);
    expect(h.spawnProcess).toHaveBeenCalledOnce();
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

type Install = { configDir: string; env: NodeJS.ProcessEnv; nodePath: string };

/**
 * Install a supervised daemon for one config root through the real ensure,
 * against an in-memory launchctl, so the launcher and plist on disk are the
 * exact bytes a user's machine holds. Each install bootstraps the per-user
 * LaunchAgent anew, so the latest install is the one launchd runs.
 */
async function installDaemon(
  home: string,
  name: string,
  version: string,
  apiUrl?: string,
): Promise<Install> {
  const configDir = join(home, name);
  const env: NodeJS.ProcessEnv = {
    PRIM_CONFIG_DIR: configDir,
    XDG_DATA_HOME: join(home, `${name}-data`),
    ...(apiUrl ? { PRIM_API_URL: apiUrl } : {}),
  };
  const launcherPath = join(configDir, "prim-daemon-launcher-v1");
  const nodePath = join(home, `${name}-node`);
  const daemonSource = join(home, `${name}-daemon.js`);
  writeFileSync(nodePath, "#!/bin/sh\n", { mode: 0o700 });
  writeFileSync(daemonSource, `daemon ${name}\n`);
  let loaded = false;
  const ok: LaunchctlResult = { status: 0, stdout: "", stderr: "" };
  const runner = (args: string[]): LaunchctlResult => {
    if (args[0] === "print") {
      return loaded
        ? {
            status: 0,
            stdout: `state = running\npid = 4242\nprogram = ${launcherPath}`,
            stderr: "",
          }
        : { status: 113, stdout: "", stderr: "Could not find service" };
    }
    if (args[0] === "bootstrap") loaded = true;
    return ok;
  };
  const inspectDaemon = async () => {
    if (!loaded) return null;
    const encoded = /^# prim-daemon-launcher: ([A-Za-z0-9_-]+)$/mu.exec(
      readFileSync(launcherPath, "utf8"),
    )?.[1] as string;
    const header = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as {
      runtimeVersion: string;
      revision: string;
    };
    return { pid: 4242, version: header.runtimeVersion, launchRevision: header.revision };
  };
  let clock = 0;
  const result = await ensureMacDaemon({
    explicitlyStarted: true,
    version,
    homeDir: home,
    env,
    nodePath,
    daemonSource,
    runner,
    inspectDaemon,
    validatePlist: () => undefined,
    migrateLegacy: async () => false,
    sleep: async (ms) => {
      clock += ms;
    },
    nowMs: () => clock,
  });
  expect(result.state).toBe("running");
  return { configDir, env, nodePath };
}

describe("healDaemonDrift against the files launchd runs", () => {
  function healFrom(
    home: string,
    install: Install,
    overrides: Partial<DaemonDriftHealOptions> = {},
  ) {
    const { spawnProcess } = fakeSpawn();
    const started = healDaemonDrift({
      platform: "darwin",
      env: install.env,
      homeDir: home,
      cliVersion: CLI,
      packageRoot: INSTALLED_ROOT,
      primEntry: "/pkg/dist/index.js",
      nodeEntry: "/usr/bin/node",
      spawnProcess,
      ...overrides,
    });
    return { started, spawnProcess };
  }

  it("upgrades only the config root whose launcher the LaunchAgent runs", async () => {
    // A second root with an older launcher (for example, a past custom
    // PRIM_CONFIG_DIR install) must not repoint the user's single daemon.
    const home = temporaryRoot("prim-drift-heal-roots-");
    const other = await installDaemon(home, "other", OLDER, "https://other.test");
    const active = await installDaemon(home, "active", OLDER);

    expect(healFrom(home, other).started).toBe(false);
    expect(existsSync(join(other.configDir, "daemon-drift-heal.json"))).toBe(false);
    expect(healFrom(home, active).started).toBe(true);
  });

  it("reads the launcher's real version, deployment, and owner", async () => {
    const home = temporaryRoot("prim-drift-heal-launcher-");
    const current = await installDaemon(home, "current", CLI, "https://staging.test");

    // Equal and runnable: nothing to do.
    expect(healFrom(home, current).started).toBe(false);
    // Another account's launcher is never replaced.
    expect(healFrom(home, current, { euid: EUID + 1, cliVersion: "0.1.0-alpha.93" }).started).toBe(
      false,
    );
    // The launcher pins staging, so only a staging-targeted command heals it.
    const production = { ...current, env: { ...current.env, PRIM_API_URL: undefined } };
    expect(healFrom(home, production, { cliVersion: "0.1.0-alpha.93" }).started).toBe(false);
    expect(healFrom(home, current, { cliVersion: "0.1.0-alpha.93" }).started).toBe(true);
  });

  it("restages an equal-version launcher whose node binary was deleted", async () => {
    const home = temporaryRoot("prim-drift-heal-node-");
    const install = await installDaemon(home, "current", CLI);
    expect(healFrom(home, install).started).toBe(false);

    unlinkSync(install.nodePath);

    expect(healFrom(home, install).started).toBe(true);
  });
});

describe("healDaemonDrift in separate processes", () => {
  // Without the regular-file guards a FIFO blocks the reading thread forever,
  // which no in-process test timeout can interrupt, and concurrent commands
  // are separate processes. These run the heal in child processes that are
  // killed if they do not answer promptly.
  let bundleDir: string;

  beforeAll(async () => {
    bundleDir = mkdtempSync(join(tmpdir(), "prim-drift-heal-bundle-"));
    await build({
      entry: [join(process.cwd(), "src/daemon/drift-heal.ts")],
      format: ["esm"],
      outDir: bundleDir,
      platform: "node",
      target: "node20",
      splitting: false,
      clean: true,
      silent: true,
    });
  }, 30_000);

  afterAll(() => {
    rmSync(bundleDir, { recursive: true, force: true });
  });

  function healInChild(options: string): Promise<{ result: boolean; spawned: number } | "blocked"> {
    const moduleUrl = pathToFileURL(join(bundleDir, "drift-heal.js")).href;
    const source = `
      const { healDaemonDrift } = await import(${JSON.stringify(moduleUrl)});
      let spawned = 0;
      const result = healDaemonDrift({
        platform: "darwin",
        cliVersion: ${JSON.stringify(CLI)},
        packageRoot: ${JSON.stringify(INSTALLED_ROOT)},
        primEntry: "/pkg/dist/index.js",
        nodeEntry: "/usr/bin/node",
        launchAgentRunsConfigRoot: () => true,
        spawnProcess: () => { spawned += 1; return { once() {}, unref() {} }; },
        ...${options},
      });
      process.stdout.write(JSON.stringify({ result, spawned }));
    `;
    return new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout.on("data", (chunk) => {
        stdout += String(chunk);
      });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve("blocked");
      }, 10_000);
      child.once("error", reject);
      child.once("exit", () => {
        clearTimeout(timer);
        try {
          resolve(JSON.parse(stdout) as { result: boolean; spawned: number });
        } catch (error) {
          reject(error);
        }
      });
    });
  }

  /**
   * Run `count` heals at once against one config root. Each child signals
   * readiness and then spins until the parent releases them together, so their
   * checks of the rate-limit record overlap.
   */
  async function raceHealInChildren(root: string, count: number): Promise<number[]> {
    const configDir = join(root, "config");
    mkdirSync(configDir, { mode: 0o700 });
    const go = join(root, "go");
    const moduleUrl = pathToFileURL(join(bundleDir, "drift-heal.js")).href;
    const options = {
      platform: "darwin",
      env: { PRIM_CONFIG_DIR: configDir, XDG_DATA_HOME: join(root, "data") },
      homeDir: join(root, "home"),
      cliVersion: CLI,
      packageRoot: INSTALLED_ROOT,
      euid: EUID,
      primEntry: "/pkg/dist/index.js",
      nodeEntry: "/usr/bin/node",
    };
    const launcher = { runtimeVersion: OLDER, ownerUid: EUID, runnable: true };
    const source = `
      const { existsSync } = await import("node:fs");
      const { healDaemonDrift } = await import(${JSON.stringify(moduleUrl)});
      let spawned = 0;
      const options = {
        ...${JSON.stringify(options)},
        selectedLauncher: () => (${JSON.stringify(launcher)}),
        launchAgentRunsConfigRoot: () => true,
        spawnProcess: () => { spawned += 1; return { once() {}, unref() {} }; },
      };
      process.stdout.write("ready\\n");
      while (!existsSync(${JSON.stringify(go)})) {}
      healDaemonDrift(options);
      process.stdout.write(JSON.stringify({ spawned }));
    `;
    let ready = 0;
    let releaseAll: () => void = () => undefined;
    const allReady = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const results = Array.from(
      { length: count },
      () =>
        new Promise<number>((resolve, reject) => {
          const child = spawn(process.execPath, ["--input-type=module", "--eval", source], {
            stdio: ["ignore", "pipe", "pipe"],
          });
          let stdout = "";
          let signaled = false;
          child.stdout.on("data", (chunk) => {
            stdout += String(chunk);
            if (!signaled && stdout.startsWith("ready\n")) {
              signaled = true;
              ready += 1;
              if (ready === count) releaseAll();
            }
          });
          const timer = setTimeout(() => child.kill("SIGKILL"), 20_000);
          child.once("error", reject);
          child.once("exit", () => {
            clearTimeout(timer);
            try {
              const result = JSON.parse(stdout.slice("ready\n".length)) as { spawned: number };
              resolve(result.spawned);
            } catch (error) {
              reject(error);
            }
          });
        }),
    );
    await allReady;
    writeFileSync(go, "");
    return Promise.all(results);
  }

  it("starts one heal when several commands start together", async () => {
    const root = temporaryRoot("prim-drift-heal-race-");

    const spawned = await raceHealInChildren(root, 8);

    expect(spawned.reduce((total, count) => total + count, 0)).toBe(1);
    expect(existsSync(join(root, "config", "daemon-drift-heal.json"))).toBe(true);
    expect(existsSync(join(root, "config", "daemon-drift-heal.lock"))).toBe(false);
  }, 30_000);

  it("treats a FIFO at the launcher path as no launcher, without blocking", async () => {
    const root = temporaryRoot("prim-drift-heal-fifo-launcher-");
    const configDir = join(root, "config");
    mkdirSync(configDir, { mode: 0o700 });
    execFileSync("mkfifo", [join(configDir, "prim-daemon-launcher-v1")]);

    await expect(
      healInChild(
        JSON.stringify({
          env: { PRIM_CONFIG_DIR: configDir, XDG_DATA_HOME: join(root, "data") },
          homeDir: join(root, "home"),
        }),
      ),
    ).resolves.toEqual({ result: false, spawned: 0 });
  }, 30_000);

  it("replaces a FIFO at the attempt marker instead of blocking on it", async () => {
    const root = temporaryRoot("prim-drift-heal-fifo-marker-");
    const configDir = join(root, "config");
    const marker = join(configDir, "daemon-drift-heal.json");
    mkdirSync(configDir, { mode: 0o700 });
    execFileSync("mkfifo", [marker]);
    const launcher = JSON.stringify({ runtimeVersion: OLDER, ownerUid: EUID, runnable: true });

    await expect(
      healInChild(
        `{ env: ${JSON.stringify({ PRIM_CONFIG_DIR: configDir, XDG_DATA_HOME: join(root, "data") })}, homeDir: ${JSON.stringify(join(root, "home"))}, selectedLauncher: () => (${launcher}) }`,
      ),
    ).resolves.toEqual({ result: true, spawned: 1 });
    expect(lstatSync(marker).isFile()).toBe(true);
  }, 30_000);
});
