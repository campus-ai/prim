import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type EnsureMacDaemonOptions,
  type LaunchctlResult,
  type LaunchctlRunner,
  bootoutMacDaemon,
  daemonExplicitlyDisabled,
  ensureMacDaemon,
  launchdPaths,
  parseLaunchdService,
  removeDaemonRuntime,
  runtimePaths,
  runtimeStatuslineCommand,
  stageRuntime,
  withDaemonLifecycleLock,
} from "./launchd.js";

const UID = 501;
function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function mode(path: string): number {
  return statSync(path).mode & 0o777;
}
function shellQuotedForTest(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}
interface Identity {
  pid: number;
  version?: string;
  launchRevision?: string;
}
interface LauncherMetadata {
  schemaVersion: number;
  nodePath: string;
  daemonPath: string;
  runtimeVersion: string;
  apiUrl: string | null;
  configDir?: string;
  revision: string;
}
function readLauncher(path: string): LauncherMetadata {
  const encoded = /^# prim-daemon-launcher: ([A-Za-z0-9_-]+)$/mu.exec(
    readFileSync(path, "utf8"),
  )?.[1];
  if (!encoded) throw new Error(`missing launcher metadata in ${path}`);
  return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as LauncherMetadata;
}
function legacyLauncher(config: LauncherMetadata): { content: string; revision: string } {
  const metadata = {
    schemaVersion: config.schemaVersion,
    nodePath: config.nodePath,
    daemonPath: config.daemonPath,
    runtimeVersion: config.runtimeVersion,
    apiUrl: config.apiUrl,
  };
  const revision = sha256(JSON.stringify(metadata));
  const encoded = Buffer.from(JSON.stringify({ ...metadata, revision })).toString("base64url");
  return {
    revision,
    content: `#!/bin/sh
# prim-daemon-launcher: ${encoded}
export PRIM_RUNTIME_VERSION=${shellQuotedForTest(config.runtimeVersion)}
export PRIM_LAUNCH_REVISION=${shellQuotedForTest(revision)}
${config.apiUrl ? `export PRIM_API_URL=${shellQuotedForTest(config.apiUrl)}` : "unset PRIM_API_URL"}
exec ${shellQuotedForTest(config.nodePath)} ${shellQuotedForTest(config.daemonPath)}
`,
  };
}
function readLegacyLauncher(path: string): LauncherMetadata | null {
  try {
    const content = readFileSync(path, "utf8");
    const encoded = /^# prim-daemon-launcher: ([A-Za-z0-9_-]+)$/mu.exec(content)?.[1];
    if (!encoded) return null;
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      value.schemaVersion !== 1 ||
      typeof value.nodePath !== "string" ||
      typeof value.daemonPath !== "string" ||
      typeof value.runtimeVersion !== "string" ||
      (value.apiUrl !== null && typeof value.apiUrl !== "string") ||
      typeof value.revision !== "string"
    ) {
      return null;
    }
    const legacy = legacyLauncher(value as unknown as LauncherMetadata);
    return legacy.revision === value.revision && legacy.content === content
      ? (value as unknown as LauncherMetadata)
      : null;
  } catch {
    return null;
  }
}
function result(
  status: number | null,
  stderr = "",
  extra: Partial<LaunchctlResult> = {},
): LaunchctlResult {
  return { status, stdout: "", stderr, ...extra };
}
function printed(program: string, pid: number): LaunchctlResult {
  return result(0, "", { stdout: `state = running\npid = ${String(pid)}\nprogram = ${program}` });
}
type BootstrapResult = LaunchctlResult & { apply?: boolean };
const temporaryRoots: string[] = [];
const macIt = process.platform === "darwin" ? it : it.skip;

class FakeLaunchd {
  readonly root = mkdtempSync(join(tmpdir(), "prim-launchd-"));
  readonly homeDir = join(this.root, "Home O'Brien & More");
  readonly dataHome = join(this.homeDir, "data");
  readonly env = { XDG_DATA_HOME: this.dataHome };
  readonly uid = UID;
  readonly label = `ai.getprimitive.test-${process.pid}-${temporaryRoots.length}`;
  readonly nodePath = join(this.root, "node");
  readonly version = "1.0.0";
  readonly nowMs = () => this.clock;
  readonly daemonSource = join(this.root, "daemon.js");
  readonly launcherPath = join(this.homeDir, ".config", "prim", "prim-daemon-launcher-v1");
  readonly paths = launchdPaths({ homeDir: this.homeDir, uid: UID, label: this.label });
  commands: string[][] = [];
  timeouts: number[] = [];
  sleeps: number[] = [];
  printQueue: LaunchctlResult[] = [];
  bootstrapQueue: BootstrapResult[] = [];
  bootstrapDefault: BootstrapResult = result(0);
  bootoutResult: BootstrapResult = result(0);
  identityQueue: Array<Identity | null> = [];
  validationError?: Error;
  legacyIdentity: Identity | null = null;
  loaded = false;
  program: string | undefined;
  pid = 987_654_321;
  runningIdentity: Identity | null = null;
  migrated = 0;
  clock = 0;
  constructor() {
    temporaryRoots.push(this.root);
    writeFileSync(this.nodePath, "#!/bin/sh\n");
    chmodSync(this.nodePath, 0o700);
    writeFileSync(this.daemonSource, "daemon-v1\n");
  }
  readonly runner: LaunchctlRunner = (args, timeoutMs) => {
    this.commands.push(args);
    this.timeouts.push(timeoutMs ?? -1);
    if (args[0] === "print") {
      const queued = this.printQueue.shift();
      if (queued) return queued;
      if (!this.loaded) return result(113, "Could not find service");
      return {
        status: 0,
        stdout: `state = running\npid = ${String(this.pid)}\n${
          this.program ? `program = ${this.program}` : ""
        }`,
        stderr: "",
      };
    }
    if (args[0] === "bootstrap") {
      const queued = this.bootstrapQueue.shift() ?? this.bootstrapDefault;
      if (queued.status === 0 || queued.apply) this.activate();
      return queued;
    }
    if (args[0] === "bootout") {
      if (this.bootoutResult.status === 0 || this.bootoutResult.apply) this.makeAbsent();
      return this.bootoutResult;
    }
    if (args[0] === "kickstart") {
      this.activate();
      return result(0);
    }
    throw new Error(`unexpected launchctl command: ${args.join(" ")}`);
  };
  readonly inspectDaemon = async (): Promise<Identity | null> => {
    if (this.identityQueue.length > 0) return this.identityQueue.shift() ?? null;
    return this.loaded ? this.runningIdentity : this.legacyIdentity;
  };
  readonly sleep = async (ms: number): Promise<void> => {
    this.sleeps.push(ms);
    this.clock += ms;
    await Promise.resolve();
  };
  readonly validatePlist = (): void => {
    if (this.validationError) throw this.validationError;
  };
  readonly migrateLegacy = async (): Promise<boolean> => {
    this.migrated++;
    this.legacyIdentity = null;
    return true;
  };
  desiredIdentity(): Identity {
    const launcher = readLauncher(this.launcherPath);
    return {
      pid: this.pid,
      version: launcher.runtimeVersion,
      launchRevision: launcher.revision,
    };
  }
  activate(): void {
    this.loaded = true;
    this.program = this.launcherPath;
    this.runningIdentity = this.desiredIdentity();
  }
  makeAbsent(): void {
    this.loaded = false;
    this.program = undefined;
    this.runningIdentity = null;
  }
  setPresent(program: string, identity: Identity): void {
    this.loaded = true;
    this.program = program;
    this.runningIdentity = identity;
    this.pid = identity.pid;
  }
  clearCommands(): void {
    this.commands = [];
    this.timeouts = [];
    this.sleeps = [];
  }
  lifecycleCommands(): string[] {
    return this.commands.filter(({ 0: command }) => command !== "print").map((args) => args[0]);
  }
  options(overrides: Partial<EnsureMacDaemonOptions> = {}): EnsureMacDaemonOptions {
    return { ...this, ...overrides, env: overrides.env ?? this.env };
  }
  ensure(overrides: Partial<EnsureMacDaemonOptions> = {}) {
    return ensureMacDaemon(this.options(overrides));
  }
  async seed(): Promise<void> {
    const seeded = await this.ensure({ explicitlyStarted: true });
    expect(seeded).toMatchObject({ state: "running", action: "bootstrap" });
    this.clearCommands();
  }
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("runtime staging", () => {
  it("stages schema-v3 daemon releases and repairs the native statusline launcher", () => {
    const fake = new FakeLaunchd();
    const options = fake.options({ version: "1.2.3" });
    const staged = stageRuntime(options);
    const releaseDir = join(staged.daemonPath, "..");
    const manifestPath = join(releaseDir, "manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as typeof staged.manifest;
    expect(manifest).toMatchObject({
      schemaVersion: 3,
      version: "1.2.3",
      daemonSha256: sha256("daemon-v1\n"),
    });
    expect(manifest).not.toHaveProperty("statuslineFile");
    expect(manifest).not.toHaveProperty("statuslineSha256");
    expect(existsSync(join(releaseDir, "prim-statusline"))).toBe(false);
    expect([staged.paths.runtimeDir, releaseDir].map(mode)).toEqual([0o700, 0o700]);
    expect([staged.daemonPath, manifestPath].map(mode)).toEqual([0o600, 0o600]);
    expect(mode(staged.paths.statuslineLauncher)).toBe(0o700);
    const launcher = readFileSync(staged.paths.statuslineLauncher, "utf8");
    expect(launcher).toContain("/usr/bin/nc -U -w 1");
    expect(launcher).toContain(
      join(fake.homeDir, ".config", "prim", "sock").replaceAll("'", `'"'"'`),
    );
    expect(launcher).toContain("primitive 1.2.3 (daemon: down)");
    expect(launcher).not.toMatch(/\b(?:node|npx)\b/u);
    expect(
      execFileSync(staged.paths.statuslineLauncher, [], {
        cwd: fake.root,
        encoding: "utf8",
        timeout: 2_000,
      }),
    ).toBe("primitive 1.2.3 (daemon: down)");

    writeFileSync(staged.paths.statuslineLauncher, "broken\n");
    expect(stageRuntime({ ...options, now: () => new Date("2027-01-01") })).toMatchObject({
      changed: false,
      daemonPath: staged.daemonPath,
    });
    expect(readFileSync(staged.paths.statuslineLauncher, "utf8")).toBe(launcher);
    expect(mode(staged.paths.statuslineLauncher)).toBe(0o700);

    writeFileSync(staged.daemonPath, "corrupt\n");
    const repaired = stageRuntime(options);
    expect(readFileSync(staged.daemonPath, "utf8")).toBe("corrupt\n");
    expect(readFileSync(repaired.daemonPath, "utf8")).toBe("daemon-v1\n");
    writeFileSync(options.daemonSource as string, "same-version-new-bytes\n");
    const repinned = stageRuntime(options);
    expect(repinned.daemonPath).not.toBe(repaired.daemonPath);
    expect(readFileSync(repaired.daemonPath, "utf8")).toBe("daemon-v1\n");
    expect(repinned.manifest.daemonSha256).toBe(sha256("same-version-new-bytes\n"));
  });

  it("restages an otherwise-current schema-v2 runtime as schema v3", () => {
    const fake = new FakeLaunchd();
    const options = fake.options({ version: "1.2.3" });
    const staged = stageRuntime(options);
    const releaseDir = join(staged.daemonPath, "..");
    const manifestPath = join(releaseDir, "manifest.json");
    writeFileSync(
      manifestPath,
      `${JSON.stringify({ ...staged.manifest, schemaVersion: 2 }, null, 2)}\n`,
    );

    const restaged = stageRuntime(options);
    expect(restaged.changed).toBe(true);
    expect(restaged.daemonPath).not.toBe(staged.daemonPath);
    expect(restaged.manifest.schemaVersion).toBe(3);
  });

  it("routes the native statusline socket through the resolved config directory", () => {
    const fake = new FakeLaunchd();
    const configDir = join(fake.root, "isolated config");
    const staged = stageRuntime(
      fake.options({
        version: "1.2.3",
        env: { XDG_DATA_HOME: fake.dataHome, PRIM_CONFIG_DIR: configDir },
      }),
    );
    const launcher = readFileSync(staged.paths.statuslineLauncher, "utf8");

    expect(launcher).toContain(join(configDir, "sock").replaceAll("'", `'"'"'`));
    expect(launcher).not.toContain(join(fake.homeDir, ".config", "prim", "sock"));
    expect(
      launchdPaths({
        homeDir: fake.homeDir,
        uid: UID,
        label: fake.label,
        env: { PRIM_CONFIG_DIR: configDir },
      }).logPath,
    ).toBe(join(configDir, "daemon.log"));
  });

  it.each([
    ["missing", {}],
    ["relative", { HOME: "relative-home", XDG_DATA_HOME: "relative-data" }],
  ])(
    "falls back to the stable hook runtime when the data-root environment is %s",
    (_label, environment) => {
      const root = mkdtempSync(join(tmpdir(), "prim-statusline-root-"));
      temporaryRoots.push(root);
      const configDir = join(root, "config");
      const launcher = join(configDir, "prim-hook-launcher-v1");
      mkdirSync(configDir, { recursive: true });
      writeFileSync(launcher, '#!/bin/sh\nprintf "stable:%s" "$1"\n', { mode: 0o700 });

      const command = runtimeStatuslineCommand();
      expect(command).toContain("prim-hook-launcher-v1");
      expect(
        execFileSync("/bin/sh", ["-c", command], {
          env: { ...environment, PRIM_CONFIG_DIR: configDir },
          encoding: "utf8",
        }),
      ).toBe("stable:prim-statusline");
    },
  );

  macIt(
    "falls back within the deadline when an old daemon accepts but never responds",
    async () => {
      const fake = new FakeLaunchd();
      const staged = stageRuntime(fake.options({ version: "1.2.3" }));
      const socketPath = join(fake.homeDir, ".config", "prim", "sock");
      mkdirSync(join(socketPath, ".."), { recursive: true });
      const child = spawn(
        process.execPath,
        [
          "--input-type=commonjs",
          "--eval",
          `
const net = require("node:net");
net.createServer((socket) => socket.on("data", () => {}))
  .listen(process.env.TEST_SOCKET, () => process.stdout.write("ready\\n"));
`,
        ],
        {
          env: { ...process.env, TEST_SOCKET: socketPath },
          stdio: ["ignore", "pipe", "ignore"],
        },
      );
      try {
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("old daemon did not listen")), 2_000);
          child.once("error", reject);
          child.stdout.on("data", (chunk) => {
            if (chunk.toString().includes("ready")) {
              clearTimeout(timer);
              resolve();
            }
          });
        });
        expect(
          execFileSync(staged.paths.statuslineLauncher, [], {
            cwd: fake.root,
            encoding: "utf8",
            timeout: 2_500,
          }),
        ).toBe("primitive 1.2.3 (daemon: down)");
      } finally {
        const exited = new Promise((resolve) => child.once("exit", resolve));
        child.kill("SIGTERM");
        await exited;
      }
    },
  );
});

describe("launchd observation", () => {
  it("classifies only trustworthy print results and sanitizes bounded errors", () => {
    expect(
      parseLaunchdService({
        status: 0,
        stdout: "state = running\npid = 4242\nprogram = /tmp/launcher\n",
        stderr: "",
      }),
    ).toMatchObject({
      loaded: true,
      state: "running",
      pid: 4242,
      program: "/tmp/launcher",
    });
    expect(parseLaunchdService(result(113, "not found"))).toEqual({ loaded: false });
    const noise = "x".repeat(5_000);
    try {
      parseLaunchdService(
        result(5, `${noise}\nTry re-running the command as root for richer errors.`),
      );
    } catch (error) {
      expect((error as Error).message).not.toContain("re-running");
      expect((error as Error).message.length).toBeLessThan(4_200);
    }
  });
});

describe("generated launchd contract", () => {
  it("writes one stable schema-v1 launcher and a structural-only validated plist", async () => {
    const fake = new FakeLaunchd();
    await fake.ensure({
      explicitlyStarted: true,
      env: { XDG_DATA_HOME: fake.dataHome, PRIM_API_URL: " https://api.test/// " },
    });
    const launcher = readLauncher(fake.launcherPath);
    const launcherText = readFileSync(fake.launcherPath, "utf8");
    const plist = readFileSync(fake.paths.plistPath, "utf8");
    expect(launcher).toMatchObject({
      schemaVersion: 1,
      runtimeVersion: "1.0.0",
      apiUrl: "https://api.test",
    });
    expect(launcher).not.toHaveProperty("configDir");
    expect(launcherText).toContain(`export PRIM_RUNTIME_VERSION='1.0.0'`);
    expect(launcherText).toContain(`export PRIM_LAUNCH_REVISION='${launcher.revision}'`);
    expect(launcherText).toContain(`export PRIM_API_URL='https://api.test'`);
    expect(launcherText).not.toContain("PRIM_CONFIG_DIR");
    expect(launcherText).toContain(`O'"'"'Brien`);
    expect(mode(fake.launcherPath)).toBe(0o700);
    const escapedLauncher = fake.launcherPath.replaceAll("&", "&amp;").replaceAll("'", "&apos;");
    expect(plist).toContain(`<string>${escapedLauncher}</string>`);
    expect(plist).toContain("<key>ExitTimeOut</key>\n  <integer>5</integer>");
    expect(plist).not.toContain("PRIM_RUNTIME_VERSION");
    expect(plist).not.toContain(launcher.daemonPath);
    fake.clearCommands();
    const second = await fake.ensure({
      env: { XDG_DATA_HOME: fake.dataHome, PRIM_API_URL: "https://other.test/" },
    });
    expect(second).toMatchObject({ action: "kickstart", plistChanged: false });
    expect(readFileSync(fake.paths.plistPath, "utf8")).toBe(plist);
    expect(readLauncher(fake.launcherPath).apiUrl).toBe("https://other.test");
    fake.clearCommands();
    writeFileSync(fake.paths.plistPath, "known-good\n");
    fake.validationError = new Error("invalid plist");
    await expect(fake.ensure()).rejects.toThrow("invalid plist");
    expect(readFileSync(fake.paths.plistPath, "utf8")).toBe("known-good\n");
    expect(fake.lifecycleCommands()).toEqual([]);
  });
});

describe("launchd reconciliation", () => {
  it("cold-boots, no-ops, and resumes from observable interrupted states", async () => {
    const fake = new FakeLaunchd();
    await fake.seed();
    expect(await fake.ensure()).toMatchObject({
      state: "running",
      action: "none",
      runtimeChanged: false,
      plistChanged: false,
      responding: true,
      socketPid: fake.pid,
    });
    expect(fake.lifecycleCommands()).toEqual([]);
    fake.makeAbsent();
    expect(await fake.ensure()).toMatchObject({ action: "bootstrap", state: "running" });
    fake.runningIdentity = { pid: fake.pid, version: "1.0.0", launchRevision: "pre-replace" };
    expect(await fake.ensure()).toMatchObject({ action: "kickstart", state: "running" });
    expect(existsSync(join(fake.dataHome, "prim", "launchd-state.json"))).toBe(false);
  });
  it.each([
    ["version", { version: "1.1.0" }],
    ["Node", { nodePath: "/different/node" }],
  ] as const)("applies a %s change with kickstart only", async (_name, change) => {
    const fake = new FakeLaunchd();
    await fake.seed();
    const changed = await fake.ensure(change);
    expect(changed.action).toBe("kickstart");
    expect(fake.lifecycleCommands()).toEqual(["kickstart"]);
  });
  it("fences automatic downgrade, rejects a corrupt incumbent, and permits explicit downgrade", async () => {
    const fake = new FakeLaunchd();
    await fake.ensure({ explicitlyStarted: true, version: "2.0.0" });
    fake.clearCommands();
    const selected = readLauncher(fake.launcherPath);
    const retained = await fake.ensure({ version: "1.0.0" });
    expect(retained).toMatchObject({ action: "none", runtimeChanged: false });
    expect(readLauncher(fake.launcherPath).daemonPath).toBe(selected.daemonPath);
    rmSync(fake.nodePath);
    await expect(fake.ensure({ version: "1.0.0" })).rejects.toThrow("unavailable or corrupt");
    writeFileSync(fake.nodePath, "#!/bin/sh\n", { mode: 0o700 });
    writeFileSync(selected.daemonPath, "corrupt\n");
    await expect(fake.ensure({ version: "1.0.0" })).rejects.toThrow(
      "unavailable or corrupt; refusing automatic downgrade",
    );
    expect(fake.lifecycleCommands()).toEqual([]);
    const downgraded = await fake.ensure({ version: "1.0.0", explicitlyStarted: true });
    expect(downgraded).toMatchObject({ action: "kickstart", runtimeChanged: true });
    expect(readLauncher(fake.launcherPath).runtimeVersion).toBe("1.0.0");
    fake.clearCommands();
    expect(await fake.ensure({ version: "nightly" })).toMatchObject({ action: "none" });
    expect(readLauncher(fake.launcherPath).runtimeVersion).toBe("1.0.0");
  });
  it("retains a newer legacy-readable default-root launcher without restarting", async () => {
    const fake = new FakeLaunchd();
    await fake.ensure({ explicitlyStarted: true, version: "2.0.0" });
    const selected = readLauncher(fake.launcherPath);
    const legacy = legacyLauncher(selected);
    writeFileSync(fake.launcherPath, legacy.content, { mode: 0o700 });
    fake.runningIdentity = {
      pid: fake.pid,
      version: selected.runtimeVersion,
      launchRevision: legacy.revision,
    };
    fake.clearCommands();

    const retained = await fake.ensure({ version: "1.0.0" });

    expect(retained.runtimeChanged).toBe(false);
    expect(readLauncher(fake.launcherPath)).toMatchObject({
      daemonPath: selected.daemonPath,
      runtimeVersion: "2.0.0",
    });
    expect(readLauncher(fake.launcherPath)).not.toHaveProperty("configDir");
    expect(fake.lifecycleCommands()).toEqual([]);
  });
  it("keeps the default-root launcher readable by the frozen prior CLI", async () => {
    const fake = new FakeLaunchd();
    await fake.ensure({ explicitlyStarted: true, version: "2.0.0" });

    const selectedByPriorCli = readLegacyLauncher(fake.launcherPath);

    expect(selectedByPriorCli).toMatchObject({
      schemaVersion: 1,
      runtimeVersion: "2.0.0",
    });

    fake.clearCommands();
    const retained = await fake.ensure({
      env: { ...fake.env, PRIM_CONFIG_DIR: join(fake.homeDir, ".config", "prim") },
      version: "1.0.0",
    });
    expect(retained).toMatchObject({ action: "none", runtimeChanged: false });
    expect(readLegacyLauncher(fake.launcherPath)?.runtimeVersion).toBe("2.0.0");
    expect(fake.lifecycleCommands()).toEqual([]);
  });
  it("converges the bootout race with one bootout and bootstrap 5, 5, 0", async () => {
    const fake = new FakeLaunchd();
    fake.setPresent("/legacy/mutable-daemon", {
      pid: fake.pid,
      version: "0.9.0",
      launchRevision: "legacy",
    });
    fake.bootoutResult = result(5, "transition in progress");
    fake.bootstrapQueue = [
      result(5, "transition in progress"),
      result(5, "transition in progress"),
      result(0),
    ];
    const repaired = await fake.ensure();
    expect(repaired).toMatchObject({ state: "running", action: "reload" });
    expect(fake.lifecycleCommands()).toEqual(["bootout", "bootstrap", "bootstrap", "bootstrap"]);
    expect(fake.sleeps).toEqual([100, 200]);
    fake.clearCommands();
    expect(await fake.ensure()).toMatchObject({ state: "running", action: "none" });
    expect(fake.lifecycleCommands()).toEqual([]);
  });
  it("accepts an ambiguously applied bootstrap and fails fast on non-retryable errors", async () => {
    const applied = new FakeLaunchd();
    applied.bootstrapQueue = [
      { ...result(null, "operation timed out", { timedOut: true }), apply: true },
    ];
    await expect(applied.ensure()).resolves.toMatchObject({
      state: "running",
      action: "bootstrap",
    });
    expect(applied.lifecycleCommands()).toEqual(["bootstrap"]);
    const rejected = new FakeLaunchd();
    rejected.bootstrapDefault = result(78, "bad request");
    await expect(rejected.ensure()).rejects.toThrow("bad request");
    expect(rejected.lifecycleCommands()).toEqual(["bootstrap"]);
  });
  it("fails closed when failed lifecycle commands cannot prove the expected state", async () => {
    const unknown = new FakeLaunchd();
    unknown.setPresent("/old", { pid: unknown.pid, version: "old" });
    unknown.bootoutResult = result(78, "bootout denied");
    unknown.printQueue = [
      printed("/old", unknown.pid),
      printed("/old", unknown.pid),
      result(null, "observation timed out", { timedOut: true }),
    ];
    await expect(unknown.ensure()).rejects.toThrow("bootout denied");
    expect(unknown.lifecycleCommands()).toEqual(["bootout"]);

    const third = new FakeLaunchd();
    third.setPresent("/old", { pid: third.pid, version: "old" });
    third.printQueue = [
      printed("/old", third.pid),
      printed("/old", third.pid),
      printed("/unexpected", third.pid),
    ];
    third.bootstrapQueue = [result(5, "transition in progress")];
    await expect(third.ensure()).rejects.toThrow("unexpected launchd program /unexpected");

    const wrongIdentity = new FakeLaunchd();
    wrongIdentity.bootstrapQueue = [{ ...result(78, "bootstrap denied"), apply: true }];
    wrongIdentity.identityQueue = [null, { pid: wrongIdentity.pid, version: "wrong" }];
    await expect(wrongIdentity.ensure()).rejects.toThrow("bootstrap denied");
  });
  it("uses one deadline and capped command timeouts when bootstrap never converges", async () => {
    const fake = new FakeLaunchd();
    fake.bootstrapDefault = result(5, "transition in progress");
    await expect(fake.ensure()).rejects.toThrow("did not converge within 15000ms");
    expect(fake.clock).toBe(15_000);
    expect(fake.sleeps.slice(0, 4)).toEqual([100, 200, 400, 500]);
    expect(Math.max(...fake.timeouts)).toBeLessThanOrEqual(5_000);
  });
  it("restarts identity mismatches and force, but ignores backend health", async () => {
    const fake = new FakeLaunchd();
    await fake.seed();
    for (const identity of [
      { pid: 1, version: "1.0.0", launchRevision: "wrong" },
      { pid: fake.pid, version: "1.0.0" },
    ]) {
      fake.identityQueue.push(identity);
      await expect(fake.ensure()).resolves.toMatchObject({ action: "kickstart", state: "running" });
    }
    await expect(fake.ensure({ forceRestart: true })).resolves.toMatchObject({
      action: "kickstart",
    });
    const backendUnhealthy = { ...fake.desiredIdentity(), backendHealthy: false };
    fake.identityQueue.push(backendUnhealthy);
    await expect(fake.ensure()).resolves.toMatchObject({ action: "none", state: "running" });
  });
});

describe("failure safety, migration, and locking", () => {
  it.each([
    ["status 5", result(5, "busy")],
    ["timeout", result(null, "timeout", { timedOut: true })],
    ["missing program", { status: 0, stdout: "state = running\npid = 1\n", stderr: "" }],
  ])("does not stage or mutate lifecycle after an initial print %s", async (_name, failure) => {
    const fake = new FakeLaunchd();
    fake.printQueue.push(failure);
    await expect(fake.ensure()).rejects.toThrow();
    expect(fake.commands.map((args) => args[0])).toEqual(["print"]);
    expect(existsSync(runtimePaths(fake).runtimeDir)).toBe(false);
    expect(existsSync(fake.launcherPath)).toBe(false);
    expect(existsSync(fake.paths.plistPath)).toBe(false);
    expect(existsSync(fake.paths.logPath)).toBe(false);
  });
  it("migrates a verified legacy owner only when launchd is absent", async () => {
    const absent = new FakeLaunchd();
    absent.legacyIdentity = { pid: 700, version: "legacy" };
    const bootstrapped = await absent.ensure();
    expect(bootstrapped.action).toBe("bootstrap");
    expect(absent.migrated).toBe(1);
    const present = new FakeLaunchd();
    await present.seed();
    present.identityQueue.push({ pid: 700, version: "foreign" });
    const repaired = await present.ensure();
    expect(repaired.action).toBe("kickstart");
    expect(present.migrated).toBe(0);
  });
  it("persists both disabled markers across stop and clears them on explicit start", async () => {
    const fake = new FakeLaunchd();
    await fake.seed();
    const legacyMarker = runtimePaths(fake).disabledMarker;
    const homeMarker = join(fake.homeDir, ".config", "prim", "daemon.disabled");
    fake.bootoutResult = result(5, "transition in progress");
    await expect(bootoutMacDaemon(fake.options())).rejects.toThrow("did not converge");
    expect(fake.sleeps.length).toBeGreaterThan(0);
    expect([legacyMarker, homeMarker].map(mode)).toEqual([0o600, 0o600]);
    fake.bootoutResult = { ...result(5, "transition in progress"), apply: true };
    const stopped = await bootoutMacDaemon(fake.options());
    expect(stopped).toMatchObject({ wasLoaded: true, legacyStopped: false });
    fake.clearCommands();
    expect(await fake.ensure()).toMatchObject({ state: "disabled", action: "none" });
    expect(fake.lifecycleCommands()).toEqual([]);
    expect(await fake.ensure({ explicitlyStarted: true })).toMatchObject({
      state: "running",
      action: "bootstrap",
    });
    expect(daemonExplicitlyDisabled(fake)).toBe(false);
  });
  it("migrates a released XDG disabled marker without staging", async () => {
    const fake = new FakeLaunchd();
    const legacyMarker = runtimePaths(fake).disabledMarker;
    mkdirSync(join(fake.dataHome, "prim"), { recursive: true });
    writeFileSync(legacyMarker, "disabled\n");
    const disabled = await fake.ensure();
    expect(disabled).toMatchObject({ state: "disabled", action: "none" });
    expect(existsSync(join(fake.homeDir, ".config", "prim", "daemon.disabled"))).toBe(true);
    expect(existsSync(runtimePaths(fake).runtimeDir)).toBe(false);
    expect(fake.lifecycleCommands()).toEqual([]);
  });
  it("serializes one HOME across XDG roots and canonicalizes lock aliases", async () => {
    const fake = new FakeLaunchd();
    const shared = join(fake.root, "shared");
    mkdirSync(join(shared, "prim"), { recursive: true });
    mkdirSync(fake.homeDir, { recursive: true });
    symlinkSync(shared, join(fake.homeDir, ".config"));
    let release!: () => void;
    const gate = new Promise<void>((resolvePromise) => {
      release = resolvePromise;
    });
    const first = withDaemonLifecycleLock(() => gate, {
      homeDir: fake.homeDir,
      env: { XDG_DATA_HOME: shared },
    });
    await Promise.resolve();
    let secondEntered = false;
    const second = withDaemonLifecycleLock(
      async () => {
        secondEntered = true;
      },
      { homeDir: fake.homeDir, env: { XDG_DATA_HOME: join(fake.root, "xdg-b") } },
    );
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
    expect(secondEntered).toBe(false);
    release();
    await Promise.all([first, second]);
    expect(secondEntered).toBe(true);
  });
});

describe("removeDaemonRuntime", () => {
  it("removes a recognized stopped daemon runtime without touching other config", async () => {
    const fake = new FakeLaunchd();
    const staged = stageRuntime({
      daemonSource: fake.daemonSource,
      nodePath: fake.nodePath,
      version: fake.version,
      homeDir: fake.homeDir,
      env: fake.env,
    });
    const configDir = join(fake.homeDir, ".config", "prim");
    mkdirSync(configDir, { recursive: true });
    const retained = join(configDir, "token");
    writeFileSync(retained, "credential\n");

    const result = await removeDaemonRuntime({
      homeDir: fake.homeDir,
      env: fake.env,
      uid: fake.uid,
      label: fake.label,
    });

    expect(result.changed).toBe(true);
    expect(existsSync(staged.paths.runtimeDir)).toBe(false);
    expect(readFileSync(retained, "utf8")).toBe("credential\n");
  });

  it("retains daemon runtime bytes when ownership is ambiguous", async () => {
    const fake = new FakeLaunchd();
    const staged = stageRuntime({
      daemonSource: fake.daemonSource,
      nodePath: fake.nodePath,
      version: fake.version,
      homeDir: fake.homeDir,
      env: fake.env,
    });
    writeFileSync(join(staged.paths.runtimeDir, "foreign.txt"), "keep me\n");

    await expect(
      removeDaemonRuntime({
        homeDir: fake.homeDir,
        env: fake.env,
        uid: fake.uid,
        label: fake.label,
      }),
    ).rejects.toThrow("unrecognized entries");
    expect(existsSync(staged.paths.runtimeDir)).toBe(true);
  });
});
