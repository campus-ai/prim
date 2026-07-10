import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LAUNCHD_LABEL,
  type LaunchctlResult,
  type LaunchctlRunner,
  type StageRuntimeOptions,
  bootoutMacDaemon,
  daemonExplicitlyDisabled,
  ensureMacDaemon,
  generateLaunchAgentPlist,
  parseLaunchdService,
  runtimePaths,
  runtimeStatuslineCommand,
  setDaemonExplicitlyDisabled,
  stageRuntime,
  withDaemonLifecycleLock,
} from "./launchd.js";

const FIXED_DATE = new Date("2026-07-10T12:00:00.000Z");

describe("runtime staging", () => {
  let dir: string;
  let daemonSource: string;
  let statuslineSource: string;
  let options: StageRuntimeOptions;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-runtime-"));
    daemonSource = join(dir, "daemon-source.js");
    statuslineSource = join(dir, "statusline-source.js");
    writeFileSync(daemonSource, "daemon-v1\n");
    writeFileSync(statuslineSource, "statusline-v1\n");
    options = {
      env: { XDG_DATA_HOME: join(dir, "data") },
      homeDir: join(dir, "home"),
      nodePath: "/opt/primitive/node",
      daemonSource,
      statuslineSource,
      version: "1.2.3",
      now: () => FIXED_DATE,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("atomically stages both standalone entries and an adjacent 0600 manifest", () => {
    const staged = stageRuntime(options);

    expect(staged.changed).toBe(true);
    expect(lstatSync(staged.paths.currentLink).isSymbolicLink()).toBe(true);
    expect(readlinkSync(staged.paths.currentLink)).toMatch(/^releases\/release-/);
    expect(readFileSync(staged.paths.daemonEntry, "utf8")).toBe("daemon-v1\n");
    expect(readFileSync(staged.paths.statuslineEntry, "utf8")).toBe("statusline-v1\n");
    expect(statSync(staged.paths.runtimeDir).mode & 0o777).toBe(0o700);
    expect(statSync(staged.paths.daemonEntry).mode & 0o777).toBe(0o600);
    expect(statSync(staged.paths.statuslineEntry).mode & 0o777).toBe(0o600);
    expect(statSync(staged.paths.statuslineLauncher).mode & 0o777).toBe(0o700);
    expect(statSync(staged.paths.manifestPath).mode & 0o777).toBe(0o600);
    expect(readFileSync(staged.paths.statuslineLauncher, "utf8")).toBe(
      `#!/bin/sh\nexec '/opt/primitive/node' '${staged.paths.statuslineEntry}'\n`,
    );
    expect(JSON.parse(readFileSync(staged.paths.manifestPath, "utf8"))).toEqual({
      schemaVersion: 1,
      version: "1.2.3",
      nodePath: "/opt/primitive/node",
      daemonFile: "prim-daemon-server",
      statuslineFile: "prim-statusline",
      stagedAt: FIXED_DATE.toISOString(),
    });
  });

  it("does not churn a matching runtime, then atomically advances on version change", () => {
    const first = stageRuntime(options);
    const firstTarget = readlinkSync(first.paths.currentLink);

    expect(stageRuntime({ ...options, now: () => new Date("2027-01-01") }).changed).toBe(false);
    const upgraded = stageRuntime({ ...options, version: "1.2.4" });

    expect(upgraded.changed).toBe(true);
    expect(readlinkSync(upgraded.paths.currentLink)).not.toBe(firstTarget);
    expect(existsSync(join(upgraded.paths.runtimeDir, firstTarget))).toBe(true);
  });

  it("stages without a statusline when that optional bundle is unavailable", () => {
    const staged = stageRuntime({ ...options, statuslineSource: null });
    expect(staged.manifest.statuslineFile).toBeUndefined();
    expect(existsSync(staged.paths.statuslineEntry)).toBe(false);
    expect(existsSync(staged.paths.statuslineLauncher)).toBe(false);
  });

  it("renders a shell-safe stable-launcher command without touching the filesystem", () => {
    const homeDir = join(dir, "O'Brien");
    const command = runtimeStatuslineCommand({
      env: {},
      homeDir,
    });

    expect(command).toBe(
      `'${join(homeDir, ".local/share/prim/runtime/prim-statusline").replaceAll("'", `'"'"'`)}'`,
    );
    expect(existsSync(runtimePaths({ env: {}, homeDir }).runtimeDir)).toBe(false);
  });

  it("keeps the persisted command stable while atomically updating its Node launcher", () => {
    const command = runtimeStatuslineCommand(options);
    const first = stageRuntime({ ...options, nodePath: "/old/node" });
    expect(readFileSync(first.paths.statuslineLauncher, "utf8")).toContain("exec '/old/node'");

    const second = stageRuntime({ ...options, nodePath: "/new/node" });
    expect(runtimeStatuslineCommand(options)).toBe(command);
    expect(readFileSync(second.paths.statuslineLauncher, "utf8")).toContain("exec '/new/node'");
    expect(readFileSync(second.paths.statuslineLauncher, "utf8")).not.toContain("/old/node");
    expect(statSync(second.paths.statuslineLauncher).mode & 0o777).toBe(0o700);
  });
});

describe("launchd contract", () => {
  it("renders the required resilient LaunchAgent keys and escapes paths", () => {
    const plist = generateLaunchAgentPlist({
      nodePath: "/Applications/Node & Tools/node",
      daemonPath: "/Users/Alice/<runtime>/prim-daemon-server",
      runtimeVersion: "1.2.3-beta&1",
      logPath: "/Users/Alice/.config/prim/daemon.log",
      workingDirectory: "/Users/Alice",
      apiUrl: "https://example.test/?a=1&b=2",
    });

    expect(plist).toContain(`<string>${LAUNCHD_LABEL}</string>`);
    expect(plist).toContain("<key>RunAtLoad</key>\n  <true/>");
    expect(plist).toContain("<key>KeepAlive</key>\n  <true/>");
    expect(plist).toContain("<key>ThrottleInterval</key>\n  <integer>10</integer>");
    expect(plist).toContain("<key>ProcessType</key>\n  <string>Background</string>");
    expect(plist).toContain("<key>Umask</key>\n  <integer>63</integer>");
    expect(plist).toContain("/Applications/Node &amp; Tools/node");
    expect(plist).toContain("/Users/Alice/&lt;runtime&gt;/prim-daemon-server");
    expect(plist).toContain("https://example.test/?a=1&amp;b=2");
    expect(plist).toContain("<key>PRIM_RUNTIME_VERSION</key>");
    expect(plist).toContain("<string>1.2.3-beta&amp;1</string>");
  });

  it("parses loaded state and pid without depending on launchctl's full text format", () => {
    expect(
      parseLaunchdService({
        status: 0,
        stdout: `gui/501/${LAUNCHD_LABEL} = {\n\tstate = running\n\tpid = 4242\n}\n`,
        stderr: "",
      }),
    ).toMatchObject({ loaded: true, state: "running", pid: 4242 });
    expect(parseLaunchdService({ status: 113, stdout: "", stderr: "not found" })).toEqual({
      loaded: false,
    });
  });
});

describe("launchd lifecycle", () => {
  let dir: string;
  let loaded: boolean;
  let servicePid: number | undefined;
  let commands: string[][];
  let runner: LaunchctlRunner;
  let base: StageRuntimeOptions & {
    uid: number;
    runner: LaunchctlRunner;
    identify: () => Promise<number>;
  };

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-launchd-"));
    const daemonSource = join(dir, "daemon.js");
    const statuslineSource = join(dir, "statusline.js");
    writeFileSync(daemonSource, "daemon\n");
    writeFileSync(statuslineSource, "statusline\n");
    loaded = false;
    servicePid = 4242;
    commands = [];
    runner = (args): LaunchctlResult => {
      commands.push(args);
      if (args[0] === "print") {
        return loaded
          ? {
              status: 0,
              stdout: `\tstate = running\n${servicePid === undefined ? "" : `\tpid = ${String(servicePid)}\n`}`,
              stderr: "",
            }
          : { status: 113, stdout: "", stderr: "not found" };
      }
      if (args[0] === "bootstrap") loaded = true;
      if (args[0] === "bootout") loaded = false;
      if (args[0] === "kickstart") servicePid = 4242;
      return { status: 0, stdout: "", stderr: "" };
    };
    base = {
      env: { XDG_DATA_HOME: join(dir, "data") },
      homeDir: join(dir, "home"),
      uid: 501,
      runner,
      identify: async () => 4242,
      nodePath: "/opt/node",
      daemonSource,
      statuslineSource,
      version: "1.0.0",
      now: () => FIXED_DATE,
    };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("bootstraps once, then leaves a matching healthy service alone", async () => {
    let probeCount = 0;
    const first = await ensureMacDaemon({
      ...base,
      explicitlyStarted: true,
      probe: async () => ++probeCount > 1,
    });
    expect(first).toMatchObject({ state: "running", action: "bootstrap", responding: true });
    expect(commands.some((args) => args[0] === "bootstrap")).toBe(true);

    commands = [];
    const second = await ensureMacDaemon({ ...base, probe: async () => true });
    expect(second).toMatchObject({ state: "running", action: "none", runtimeChanged: false });
    expect(commands.some((args) => args[0] === "kickstart")).toBe(false);
    expect(commands.some((args) => args[0] === "bootstrap")).toBe(false);
  });

  it("kickstarts an unhealthy service and reloads an upgraded runtime", async () => {
    loaded = true;
    await ensureMacDaemon({ ...base, probe: async () => true });
    commands = [];
    let probeCount = 0;
    const healed = await ensureMacDaemon({
      ...base,
      probe: async () => ++probeCount > 1,
    });
    expect(healed.action).toBe("kickstart");
    expect(commands).toContainEqual(["kickstart", "-k", `gui/501/${LAUNCHD_LABEL}`]);

    commands = [];
    const upgraded = await ensureMacDaemon({
      ...base,
      version: "1.0.1",
      probe: async () => true,
    });
    expect(upgraded).toMatchObject({ action: "reload", runtimeChanged: true });
  });

  it("reloads launchd when the persisted plist changes", async () => {
    loaded = true;
    await ensureMacDaemon({ ...base, probe: async () => true });
    commands = [];

    const changed = await ensureMacDaemon({
      ...base,
      nodePath: "/new/node",
      probe: async () => true,
    });

    expect(changed.action).toBe("reload");
    expect(commands).toContainEqual(["bootout", `gui/501/${LAUNCHD_LABEL}`]);
    expect(commands).toContainEqual([
      "bootstrap",
      "gui/501",
      join(base.homeDir as string, "Library/LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    ]);
  });

  it("migrates a verified legacy socket owner before kickstarting the loaded job", async () => {
    loaded = true;
    await ensureMacDaemon({ ...base, probe: async () => true });
    commands = [];
    let identifyCount = 0;
    let migrated = 0;

    const repaired = await ensureMacDaemon({
      ...base,
      probe: async () => true,
      identify: async () => (++identifyCount === 1 ? 999 : 4242),
      migrateLegacy: async () => {
        migrated++;
        return true;
      },
    });

    expect(migrated).toBe(1);
    expect(repaired).toMatchObject({ state: "running", action: "kickstart", socketPid: 4242 });
    expect(commands).toContainEqual(["kickstart", "-k", `gui/501/${LAUNCHD_LABEL}`]);
  });

  it("verified-stops an identified socket when launchctl omits its pid", async () => {
    await ensureMacDaemon({
      ...base,
      explicitlyStarted: true,
      probe: async () => true,
      migrateLegacy: async () => true,
    });
    servicePid = undefined;
    commands = [];
    let migrated = 0;

    const repaired = await ensureMacDaemon({
      ...base,
      probe: async () => true,
      identify: async () => 4242,
      migrateLegacy: async () => {
        migrated++;
        return true;
      },
    });

    expect(migrated).toBe(1);
    expect(repaired).toMatchObject({ state: "running", action: "kickstart", socketPid: 4242 });
    expect(commands).toContainEqual(["kickstart", "-k", `gui/501/${LAUNCHD_LABEL}`]);
  });

  it("respects a deliberate stop until an explicit start clears the marker", async () => {
    setDaemonExplicitlyDisabled(true, base);
    const disabled = await ensureMacDaemon({
      ...base,
      daemonSource: join(dir, "does-not-exist"),
      probe: async () => true,
    });
    expect(disabled).toMatchObject({ state: "disabled", action: "none" });
    expect(commands.every((args) => args[0] === "print")).toBe(true);

    const started = await ensureMacDaemon({
      ...base,
      explicitlyStarted: true,
      probe: async () => true,
      migrateLegacy: async () => true,
    });
    expect(started.state).toBe("running");
    expect(daemonExplicitlyDisabled(base)).toBe(false);
  });

  it("bootout writes the disable marker and never signals a pid", async () => {
    loaded = true;
    const stopped = await bootoutMacDaemon({ ...base, probe: async () => false });
    expect(stopped).toMatchObject({ wasLoaded: true, legacyStopped: false });
    expect(commands).toContainEqual(["bootout", `gui/501/${LAUNCHD_LABEL}`]);
    expect(daemonExplicitlyDisabled(base)).toBe(true);
  });

  it("serializes concurrent ensures so only one process bootstraps", async () => {
    let releaseProbe!: () => void;
    const probeReleased = new Promise<void>((resolvePromise) => {
      releaseProbe = resolvePromise;
    });
    let enteredProbe!: () => void;
    const probeEntered = new Promise<void>((resolvePromise) => {
      enteredProbe = resolvePromise;
    });
    let firstProbeCount = 0;
    const first = ensureMacDaemon({
      ...base,
      explicitlyStarted: true,
      probe: async () => {
        firstProbeCount++;
        if (firstProbeCount === 1) {
          enteredProbe();
          await probeReleased;
          return false;
        }
        return true;
      },
    });
    await probeEntered;
    const second = ensureMacDaemon({ ...base, probe: async () => true });

    releaseProbe();
    const [firstResult, secondResult] = await Promise.all([first, second]);

    expect(firstResult.action).toBe("bootstrap");
    expect(secondResult.action).toBe("none");
    expect(commands.filter((args) => args[0] === "bootstrap")).toHaveLength(1);
  });

  it("makes a concurrent stop win after an in-flight ensure", async () => {
    let releaseProbe!: () => void;
    const probeReleased = new Promise<void>((resolvePromise) => {
      releaseProbe = resolvePromise;
    });
    let enteredProbe!: () => void;
    const probeEntered = new Promise<void>((resolvePromise) => {
      enteredProbe = resolvePromise;
    });
    let probeCount = 0;
    const ensuring = ensureMacDaemon({
      ...base,
      explicitlyStarted: true,
      probe: async () => {
        probeCount++;
        if (probeCount === 1) {
          enteredProbe();
          await probeReleased;
          return false;
        }
        return true;
      },
    });
    await probeEntered;
    const stopping = bootoutMacDaemon({ ...base, probe: async () => false });

    releaseProbe();
    const [ensured, stopped] = await Promise.all([ensuring, stopping]);

    expect(ensured.action).toBe("bootstrap");
    expect(stopped.wasLoaded).toBe(true);
    expect(loaded).toBe(false);
    expect(daemonExplicitlyDisabled(base)).toBe(true);
    expect(commands.findIndex((args) => args[0] === "bootstrap")).toBeLessThan(
      commands.findIndex((args) => args[0] === "bootout"),
    );
  });

  it("recovers a lifecycle lock whose recorded owner is dead", async () => {
    const lockDir = runtimePaths(base).lifecycleLockDir;
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: 999_999, nonce: "dead-owner", createdAt: Date.now() - 5_000 })}\n`,
    );

    const result = await withDaemonLifecycleLock(async () => "acquired", {
      ...base,
      lifecycleLock: { processAlive: () => false, pollMs: 1 },
    });

    expect(result).toBe("acquired");
    expect(existsSync(lockDir)).toBe(false);
  });

  it("recovers when an owner died between creating the lock and writing metadata", async () => {
    const lockDir = runtimePaths(base).lifecycleLockDir;
    mkdirSync(lockDir, { recursive: true });
    const afterGrace = statSync(lockDir).mtimeMs + 3_000;

    const result = await withDaemonLifecycleLock(async () => "acquired", {
      ...base,
      lifecycleLock: {
        nowMs: () => afterGrace,
        processAlive: () => false,
        pollMs: 1,
      },
    });

    expect(result).toBe("acquired");
    expect(existsSync(lockDir)).toBe(false);
  });
});
