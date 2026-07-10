import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { binFile } from "../lib/bin-path.js";
import { daemonIsLive, daemonRequest } from "./client.js";

export const LAUNCHD_LABEL = "ai.getprimitive.prim-daemon";

const RUNTIME_SCHEMA_VERSION = 1;
const RUNTIME_DIR_MODE = 0o700;
const RUNTIME_FILE_MODE = 0o600;
const RUNTIME_LAUNCHER_MODE = 0o700;
const PLIST_FILE_MODE = 0o600;
const READY_TIMEOUT_MS = 15_000;
const READY_POLL_MS = 100;
const READY_PROBE_TIMEOUT_MS = 250;
const LIFECYCLE_LOCK_TIMEOUT_MS = 30_000;
const LIFECYCLE_LOCK_POLL_MS = 50;
const LIFECYCLE_LOCK_INIT_GRACE_MS = 2_000;

export interface RuntimePathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface RuntimePaths {
  dataDir: string;
  runtimeDir: string;
  releasesDir: string;
  currentLink: string;
  daemonEntry: string;
  statuslineEntry: string;
  statuslineLauncher: string;
  manifestPath: string;
  disabledMarker: string;
  lifecycleLockDir: string;
}

export interface RuntimeManifest {
  schemaVersion: number;
  version: string;
  nodePath: string;
  daemonFile: "prim-daemon-server";
  statuslineFile?: "prim-statusline";
  stagedAt: string;
}

export interface StageRuntimeOptions extends RuntimePathOptions {
  nodePath?: string;
  daemonSource?: string | null;
  statuslineSource?: string | null;
  version?: string;
  now?: () => Date;
}

export interface StageRuntimeResult {
  changed: boolean;
  manifest: RuntimeManifest;
  paths: RuntimePaths;
}

export interface LaunchAgentConfig {
  nodePath: string;
  daemonPath: string;
  runtimeVersion: string;
  logPath: string;
  workingDirectory: string;
  apiUrl?: string;
}

export interface LaunchctlResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (args: string[]) => LaunchctlResult;

export interface LaunchdService {
  loaded: boolean;
  state?: string;
  pid?: number;
  raw?: string;
}

export interface LaunchdPathOptions extends RuntimePathOptions {
  uid?: number;
}

export interface LaunchdPaths {
  domainTarget: string;
  serviceTarget: string;
  plistPath: string;
  logPath: string;
}

export interface EnsureMacDaemonOptions extends StageRuntimeOptions {
  runner?: LaunchctlRunner;
  probe?: (timeoutMs: number) => Promise<boolean>;
  identify?: (timeoutMs: number) => Promise<number | null>;
  sleep?: (ms: number) => Promise<void>;
  uid?: number;
  explicitlyStarted?: boolean;
  forceRestart?: boolean;
  migrateLegacy?: () => Promise<boolean>;
  lifecycleLock?: LifecycleLockControl;
}

export interface LifecycleLockControl {
  timeoutMs?: number;
  pollMs?: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
  processAlive?: (pid: number) => boolean;
}

export interface EnsureMacDaemonResult {
  state: "disabled" | "running" | "unhealthy";
  action: "none" | "bootstrap" | "reload" | "kickstart";
  runtimeChanged: boolean;
  plistChanged: boolean;
  responding: boolean;
  socketPid?: number;
  service: LaunchdService;
  runtime?: StageRuntimeResult;
}

function xdgDataHome(options: RuntimePathOptions): string {
  const home = options.homeDir ?? homedir();
  const configured = (options.env ?? process.env).XDG_DATA_HOME;
  return configured && isAbsolute(configured) ? configured : join(home, ".local", "share");
}

/** Stable paths used by launchd and Claude's lightweight status-line command. */
export function runtimePaths(options: RuntimePathOptions = {}): RuntimePaths {
  const dataDir = join(xdgDataHome(options), "prim");
  const runtimeDir = join(dataDir, "runtime");
  const currentLink = join(runtimeDir, "current");
  return {
    dataDir,
    runtimeDir,
    releasesDir: join(runtimeDir, "releases"),
    currentLink,
    daemonEntry: join(currentLink, "prim-daemon-server"),
    statuslineEntry: join(currentLink, "prim-statusline"),
    statuslineLauncher: join(runtimeDir, "prim-statusline"),
    manifestPath: join(currentLink, "manifest.json"),
    disabledMarker: join(dataDir, "daemon.disabled"),
    lifecycleLockDir: join(dataDir, "daemon.lifecycle.lock"),
  };
}

function findPackageVersion(entryFile: string): string {
  let dir = dirname(resolve(entryFile));
  for (let depth = 0; depth < 6; depth++) {
    const packagePath = join(dir, "package.json");
    if (existsSync(packagePath)) {
      try {
        const manifest = JSON.parse(readFileSync(packagePath, "utf8")) as {
          name?: string;
          version?: string;
        };
        if (manifest.name === "@primitive.ai/prim" && manifest.version) {
          return manifest.version;
        }
      } catch {
        // Keep walking; a parent package may be the published prim package.
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot determine @primitive.ai/prim version from ${entryFile}`);
}

function readRuntimeManifest(path: string): RuntimeManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<RuntimeManifest>;
    if (
      parsed.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
      typeof parsed.version !== "string" ||
      typeof parsed.nodePath !== "string" ||
      parsed.daemonFile !== "prim-daemon-server"
    ) {
      return null;
    }
    return parsed as RuntimeManifest;
  } catch {
    return null;
  }
}

function sameRuntime(
  current: RuntimeManifest | null,
  desired: RuntimeManifest,
  paths: RuntimePaths,
): boolean {
  return Boolean(
    current &&
      current.version === desired.version &&
      current.nodePath === desired.nodePath &&
      current.statuslineFile === desired.statuslineFile &&
      existsSync(paths.daemonEntry) &&
      (desired.statuslineFile === undefined || existsSync(paths.statuslineEntry)),
  );
}

function atomicSymlink(target: string, linkPath: string): void {
  const tempLink = `${linkPath}.tmp-${process.pid}-${createHash("sha256")
    .update(`${target}\0${Date.now()}\0${Math.random()}`)
    .digest("hex")
    .slice(0, 12)}`;
  symlinkSync(target, tempLink);
  try {
    renameSync(tempLink, linkPath);
  } catch (error) {
    rmSync(tempLink, { force: true });
    throw error;
  }
}

/**
 * Copy the standalone runtime entries into an immutable release directory,
 * then atomically repoint `runtime/current`. The manifest is written beside
 * the entries so either standalone binary can identify the staged version.
 */
export function stageRuntime(options: StageRuntimeOptions = {}): StageRuntimeResult {
  const paths = runtimePaths(options);
  const daemonSource = options.daemonSource ?? binFile("prim-daemon-server");
  if (!daemonSource || !existsSync(daemonSource)) {
    throw new Error("cannot stage runtime: prim-daemon-server bundle is unavailable");
  }
  const configuredStatusline =
    options.statuslineSource === undefined ? binFile("prim-statusline") : options.statuslineSource;
  const statuslineSource =
    configuredStatusline && existsSync(configuredStatusline) ? configuredStatusline : null;
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const version = options.version ?? findPackageVersion(daemonSource);
  const desired: RuntimeManifest = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    version,
    nodePath,
    daemonFile: "prim-daemon-server",
    ...(statuslineSource ? { statuslineFile: "prim-statusline" as const } : {}),
    stagedAt: (options.now?.() ?? new Date()).toISOString(),
  };

  const current = readRuntimeManifest(paths.manifestPath);
  if (sameRuntime(current, desired, paths)) {
    if (current?.statuslineFile) {
      atomicWrite(
        paths.statuslineLauncher,
        statuslineLauncherContent(paths, current.nodePath),
        RUNTIME_LAUNCHER_MODE,
      );
    } else {
      rmSync(paths.statuslineLauncher, { force: true });
    }
    return { changed: false, manifest: current as RuntimeManifest, paths };
  }

  mkdirSync(paths.releasesDir, { recursive: true, mode: RUNTIME_DIR_MODE });
  chmodSync(paths.runtimeDir, RUNTIME_DIR_MODE);
  chmodSync(paths.releasesDir, RUNTIME_DIR_MODE);

  const stagingDir = mkdtempSync(join(paths.releasesDir, ".stage-"));
  chmodSync(stagingDir, RUNTIME_DIR_MODE);
  try {
    const daemonTarget = join(stagingDir, desired.daemonFile);
    copyFileSync(daemonSource, daemonTarget);
    chmodSync(daemonTarget, RUNTIME_FILE_MODE);
    if (statuslineSource && desired.statuslineFile) {
      const statuslineTarget = join(stagingDir, desired.statuslineFile);
      copyFileSync(statuslineSource, statuslineTarget);
      chmodSync(statuslineTarget, RUNTIME_FILE_MODE);
    }
    const manifestTarget = join(stagingDir, "manifest.json");
    writeFileSync(manifestTarget, `${JSON.stringify(desired, null, 2)}\n`, {
      encoding: "utf8",
      mode: RUNTIME_FILE_MODE,
      flag: "wx",
    });

    const releaseName = `release-${createHash("sha256")
      .update(
        `${version}\0${nodePath}\0${desired.statuslineFile ?? ""}\0${desired.stagedAt}\0${process.pid}\0${Math.random()}`,
      )
      .digest("hex")
      .slice(0, 16)}`;
    const releaseDir = join(paths.releasesDir, releaseName);
    renameSync(stagingDir, releaseDir);
    atomicSymlink(join("releases", releaseName), paths.currentLink);
    if (desired.statuslineFile) {
      atomicWrite(
        paths.statuslineLauncher,
        statuslineLauncherContent(paths, desired.nodePath),
        RUNTIME_LAUNCHER_MODE,
      );
    } else {
      rmSync(paths.statuslineLauncher, { force: true });
    }
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return { changed: true, manifest: desired, paths };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function statuslineLauncherContent(paths: RuntimePaths, nodePath: string): string {
  return `#!/bin/sh\nexec ${shellQuote(nodePath)} ${shellQuote(paths.statuslineEntry)}\n`;
}

/** Pure command rendering; callers stage first, then persist this command. */
export function runtimeStatuslineCommand(options: RuntimePathOptions = {}): string {
  return shellQuote(runtimePaths(options).statuslineLauncher);
}

function xmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/** Pure plist generation, kept deterministic for review and tests. */
export function generateLaunchAgentPlist(config: LaunchAgentConfig): string {
  const apiUrl = config.apiUrl
    ? `\n      <key>PRIM_API_URL</key>\n      <string>${xmlEscape(config.apiUrl)}</string>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LAUNCHD_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(config.nodePath)}</string>
    <string>${xmlEscape(config.daemonPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>Umask</key>
  <integer>63</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.logPath)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PRIM_RUNTIME_VERSION</key>
    <string>${xmlEscape(config.runtimeVersion)}</string>${apiUrl}
  </dict>
</dict>
</plist>
`;
}

export function launchdPaths(options: LaunchdPathOptions = {}): LaunchdPaths {
  const home = options.homeDir ?? homedir();
  const uid = options.uid ?? process.getuid?.();
  if (uid === undefined) throw new Error("cannot determine uid for launchd user domain");
  return {
    domainTarget: `gui/${uid}`,
    serviceTarget: `gui/${uid}/${LAUNCHD_LABEL}`,
    plistPath: join(home, "Library", "LaunchAgents", `${LAUNCHD_LABEL}.plist`),
    logPath: join(home, ".config", "prim", "daemon.log"),
  };
}

export const runLaunchctl: LaunchctlRunner = (args) => {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8" });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.error?.message ?? result.stderr ?? "",
  };
};

/** Parse only stable, useful fields from `launchctl print`. */
export function parseLaunchdService(result: LaunchctlResult): LaunchdService {
  if (result.status !== 0) return { loaded: false };
  const state = /^\s*state = (.+?)\s*$/m.exec(result.stdout)?.[1];
  const rawPid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1];
  const pid = rawPid ? Number(rawPid) : undefined;
  return { loaded: true, state, pid, raw: result.stdout };
}

export function getLaunchdService(
  options: LaunchdPathOptions & { runner?: LaunchctlRunner } = {},
): LaunchdService {
  const paths = launchdPaths(options);
  return parseLaunchdService((options.runner ?? runLaunchctl)(["print", paths.serviceTarget]));
}

function atomicWrite(path: string, content: string, mode: number): boolean {
  try {
    if (readFileSync(path, "utf8") === content) {
      chmodSync(path, mode);
      return false;
    }
  } catch {
    // Missing or unreadable: replace it below.
  }
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { encoding: "utf8", mode, flag: "wx" });
  try {
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return true;
}

function launchctlOrThrow(
  runner: LaunchctlRunner,
  args: string[],
  operation: string,
): LaunchctlResult {
  const result = runner(args);
  if (result.status !== 0) {
    const detail = result.stderr.trim() || result.stdout.trim() || `exit ${String(result.status)}`;
    throw new Error(`launchctl ${operation} failed: ${detail}`);
  }
  return result;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

async function identifyDaemon(timeoutMs: number): Promise<number | null> {
  const snapshot = await daemonRequest<{ pid?: number }>("status_snapshot", {}, { timeoutMs });
  return typeof snapshot?.pid === "number" ? snapshot.pid : null;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

interface LifecycleLockOwner {
  pid: number;
  nonce: string;
  createdAt: number;
}

function lifecycleOwnerPath(lockDir: string): string {
  return join(lockDir, "owner.json");
}

function readLifecycleOwner(lockDir: string): LifecycleLockOwner | null {
  try {
    const owner = JSON.parse(
      readFileSync(lifecycleOwnerPath(lockDir), "utf8"),
    ) as Partial<LifecycleLockOwner>;
    if (
      !Number.isInteger(owner.pid) ||
      (owner.pid as number) <= 0 ||
      typeof owner.nonce !== "string" ||
      typeof owner.createdAt !== "number"
    ) {
      return null;
    }
    return owner as LifecycleLockOwner;
  } catch {
    return null;
  }
}

function sameLifecycleOwner(a: LifecycleLockOwner | null, b: LifecycleLockOwner): boolean {
  return a?.pid === b.pid && a.nonce === b.nonce && a.createdAt === b.createdAt;
}

function tryTakeLifecycleLock(lockDir: string, now: number): LifecycleLockOwner | null {
  try {
    mkdirSync(lockDir, { mode: RUNTIME_DIR_MODE });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return null;
    throw error;
  }
  const owner: LifecycleLockOwner = {
    pid: process.pid,
    nonce: createHash("sha256").update(`${process.pid}\0${now}\0${Math.random()}`).digest("hex"),
    createdAt: now,
  };
  try {
    writeFileSync(lifecycleOwnerPath(lockDir), `${JSON.stringify(owner)}\n`, {
      encoding: "utf8",
      mode: RUNTIME_FILE_MODE,
      flag: "wx",
    });
    return owner;
  } catch (error) {
    rmSync(lockDir, { recursive: true, force: true });
    throw error;
  }
}

function recoverStaleLifecycleLock(
  lockDir: string,
  now: number,
  alive: (pid: number) => boolean,
): boolean {
  const owner = readLifecycleOwner(lockDir);
  if (owner) {
    if (alive(owner.pid)) return false;
    if (!sameLifecycleOwner(readLifecycleOwner(lockDir), owner)) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  }

  // A process can die between mkdir and owner.json. Give a live acquirer a
  // generous initialization window, then recover only if the directory stayed
  // unchanged and still has no valid owner.
  try {
    const before = statSync(lockDir).mtimeMs;
    if (now - before < LIFECYCLE_LOCK_INIT_GRACE_MS) return false;
    if (readLifecycleOwner(lockDir)) return false;
    if (statSync(lockDir).mtimeMs !== before) return false;
    rmSync(lockDir, { recursive: true, force: true });
    return true;
  } catch {
    return true;
  }
}

/** Serialize daemon lifecycle mutation across concurrent agent sessions. */
export async function withDaemonLifecycleLock<T>(
  operation: () => Promise<T>,
  options: RuntimePathOptions & { lifecycleLock?: LifecycleLockControl } = {},
): Promise<T> {
  const lockDir = runtimePaths(options).lifecycleLockDir;
  mkdirSync(dirname(lockDir), { recursive: true, mode: RUNTIME_DIR_MODE });
  const control = options.lifecycleLock;
  const nowMs = control?.nowMs ?? Date.now;
  const sleepFor = control?.sleep ?? defaultSleep;
  const alive = control?.processAlive ?? processIsAlive;
  const deadline = nowMs() + (control?.timeoutMs ?? LIFECYCLE_LOCK_TIMEOUT_MS);

  let owner: LifecycleLockOwner | null = null;
  while (!owner) {
    const now = nowMs();
    owner = tryTakeLifecycleLock(lockDir, now);
    if (owner) break;
    recoverStaleLifecycleLock(lockDir, now, alive);
    if (now >= deadline) {
      throw new Error(`timed out waiting for daemon lifecycle lock ${lockDir}`);
    }
    await sleepFor(control?.pollMs ?? LIFECYCLE_LOCK_POLL_MS);
  }

  try {
    return await operation();
  } finally {
    if (sameLifecycleOwner(readLifecycleOwner(lockDir), owner)) {
      rmSync(lockDir, { recursive: true, force: true });
    }
  }
}

/**
 * One-time migration from the old detached service. A live pidfile alone is
 * never authority: the socket must identify the same pid immediately before
 * it is signalled.
 */
async function stopVerifiedLegacyDaemon(homeDir: string): Promise<boolean> {
  const pidPath = join(homeDir, ".config", "prim", "daemon.pid");
  let pid: number;
  try {
    pid = Number(readFileSync(pidPath, "utf8").trim());
  } catch {
    throw new Error("an unsupervised daemon answered, but it has no verifiable pidfile");
  }
  const snapshot = await daemonRequest<{ pid?: number }>("status_snapshot", {}, { timeoutMs: 500 });
  if (!Number.isInteger(pid) || pid <= 0 || !processIsAlive(pid) || snapshot?.pid !== pid) {
    throw new Error("refusing to signal an unsupervised daemon whose pid cannot be verified");
  }
  process.kill(pid, "SIGTERM");
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline && processIsAlive(pid)) {
    await defaultSleep(100);
  }
  if (processIsAlive(pid)) {
    throw new Error(`verified legacy daemon pid=${pid} did not stop within 5000ms`);
  }
  return true;
}

async function waitForReady(
  probe: (timeoutMs: number) => Promise<boolean>,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(READY_PROBE_TIMEOUT_MS)) return true;
    await sleep(READY_POLL_MS);
  }
  return probe(READY_PROBE_TIMEOUT_MS);
}

export function daemonExplicitlyDisabled(options: RuntimePathOptions = {}): boolean {
  return existsSync(runtimePaths(options).disabledMarker);
}

export function setDaemonExplicitlyDisabled(
  disabled: boolean,
  options: RuntimePathOptions = {},
): void {
  const marker = runtimePaths(options).disabledMarker;
  if (!disabled) {
    rmSync(marker, { force: true });
    return;
  }
  mkdirSync(dirname(marker), { recursive: true, mode: RUNTIME_DIR_MODE });
  writeFileSync(marker, "disabled by `prim daemon stop`\n", {
    encoding: "utf8",
    mode: RUNTIME_FILE_MODE,
  });
  chmodSync(marker, RUNTIME_FILE_MODE);
}

/**
 * Idempotently install/upgrade and heal the per-user launchd service. Session
 * hooks call this without `explicitlyStarted`, so a deliberate stop persists.
 */
export async function ensureMacDaemon(
  options: EnsureMacDaemonOptions = {},
): Promise<EnsureMacDaemonResult> {
  return withDaemonLifecycleLock(() => ensureMacDaemonLocked(options), options);
}

async function ensureMacDaemonLocked(
  options: EnsureMacDaemonOptions,
): Promise<EnsureMacDaemonResult> {
  if (!options.explicitlyStarted && daemonExplicitlyDisabled(options)) {
    return {
      state: "disabled",
      action: "none",
      runtimeChanged: false,
      plistChanged: false,
      responding: false,
      service: getLaunchdService(options),
    };
  }
  if (options.explicitlyStarted) setDaemonExplicitlyDisabled(false, options);

  const runtime = stageRuntime(options);
  const servicePaths = launchdPaths(options);
  mkdirSync(dirname(servicePaths.logPath), { recursive: true, mode: RUNTIME_DIR_MODE });
  writeFileSync(servicePaths.logPath, "", { mode: RUNTIME_FILE_MODE, flag: "a" });
  chmodSync(servicePaths.logPath, RUNTIME_FILE_MODE);

  const plist = generateLaunchAgentPlist({
    nodePath: runtime.manifest.nodePath,
    daemonPath: runtime.paths.daemonEntry,
    runtimeVersion: runtime.manifest.version,
    logPath: servicePaths.logPath,
    workingDirectory: options.homeDir ?? homedir(),
    apiUrl: (options.env ?? process.env).PRIM_API_URL,
  });
  const plistChanged = atomicWrite(servicePaths.plistPath, plist, PLIST_FILE_MODE);
  const runner = options.runner ?? runLaunchctl;
  let service = getLaunchdService({ ...options, runner });
  let action: EnsureMacDaemonResult["action"] = "none";

  if (service.loaded && plistChanged) {
    launchctlOrThrow(runner, ["bootout", servicePaths.serviceTarget], "bootout");
    launchctlOrThrow(
      runner,
      ["bootstrap", servicePaths.domainTarget, servicePaths.plistPath],
      "bootstrap",
    );
    action = "reload";
  } else if (!service.loaded) {
    if (await (options.probe ?? daemonIsLive)(READY_PROBE_TIMEOUT_MS)) {
      await (
        options.migrateLegacy ?? (() => stopVerifiedLegacyDaemon(options.homeDir ?? homedir()))
      )();
    }
    launchctlOrThrow(
      runner,
      ["bootstrap", servicePaths.domainTarget, servicePaths.plistPath],
      "bootstrap",
    );
    action = "bootstrap";
  } else {
    const healthy = await (options.probe ?? daemonIsLive)(READY_PROBE_TIMEOUT_MS);
    const socketPid = healthy
      ? await (options.identify ?? identifyDaemon)(READY_PROBE_TIMEOUT_MS)
      : null;
    const ownsSocket = service.pid !== undefined && socketPid !== null && service.pid === socketPid;
    if (healthy && socketPid !== null && !ownsSocket) {
      await (
        options.migrateLegacy ?? (() => stopVerifiedLegacyDaemon(options.homeDir ?? homedir()))
      )();
    }
    if (runtime.changed || options.forceRestart || !healthy || !ownsSocket) {
      launchctlOrThrow(runner, ["kickstart", "-k", servicePaths.serviceTarget], "kickstart");
      action = "kickstart";
    }
  }

  const responding = await waitForReady(
    options.probe ?? daemonIsLive,
    options.sleep ?? defaultSleep,
  );
  service = getLaunchdService({ ...options, runner });
  const socketPid = responding
    ? await (options.identify ?? identifyDaemon)(READY_PROBE_TIMEOUT_MS)
    : null;
  const running =
    responding &&
    service.loaded &&
    service.pid !== undefined &&
    socketPid !== null &&
    service.pid === socketPid;
  return {
    state: running ? "running" : "unhealthy",
    action,
    runtimeChanged: runtime.changed,
    plistChanged,
    responding,
    ...(socketPid === null ? {} : { socketPid }),
    service,
    runtime,
  };
}

/** Stop the loaded service; migrate-stop a verified legacy detached daemon. */
export async function bootoutMacDaemon(
  options: RuntimePathOptions & {
    runner?: LaunchctlRunner;
    uid?: number;
    probe?: (timeoutMs: number) => Promise<boolean>;
    migrateLegacy?: () => Promise<boolean>;
    lifecycleLock?: LifecycleLockControl;
  } = {},
): Promise<{ wasLoaded: boolean; legacyStopped: boolean; service: LaunchdService }> {
  return withDaemonLifecycleLock(() => bootoutMacDaemonLocked(options), options);
}

async function bootoutMacDaemonLocked(
  options: RuntimePathOptions & {
    runner?: LaunchctlRunner;
    uid?: number;
    probe?: (timeoutMs: number) => Promise<boolean>;
    migrateLegacy?: () => Promise<boolean>;
    lifecycleLock?: LifecycleLockControl;
  },
): Promise<{ wasLoaded: boolean; legacyStopped: boolean; service: LaunchdService }> {
  setDaemonExplicitlyDisabled(true, options);
  const runner = options.runner ?? runLaunchctl;
  const paths = launchdPaths(options);
  const service = getLaunchdService({ ...options, runner });
  if (service.loaded) {
    launchctlOrThrow(runner, ["bootout", paths.serviceTarget], "bootout");
    return { wasLoaded: true, legacyStopped: false, service };
  }
  const legacyStopped = (await (options.probe ?? daemonIsLive)(READY_PROBE_TIMEOUT_MS))
    ? await (
        options.migrateLegacy ?? (() => stopVerifiedLegacyDaemon(options.homeDir ?? homedir()))
      )()
    : false;
  return { wasLoaded: false, legacyStopped, service };
}
