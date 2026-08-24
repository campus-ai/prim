import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  accessSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { binFile, stableHookCommand } from "../lib/bin-path.js";
import { withFileLock } from "../lib/file-lock.js";
import { primConfigDirectory } from "../lib/paths.js";
import { processIsAlive } from "../lib/process-liveness.js";
import { compareSemver } from "../lib/semver.js";
import { daemonRequest } from "./client.js";
import { normalizeApiUrl } from "./env-binding.js";

export const LAUNCHD_LABEL = "ai.getprimitive.prim-daemon";

const RUNTIME_SCHEMA_VERSION = 3;
const RUNTIME_DIR_MODE = 0o700;
const RUNTIME_FILE_MODE = 0o600;
const RUNTIME_LAUNCHER_MODE = 0o700;
const PLIST_FILE_MODE = 0o600;
const LAUNCHER_SCHEMA_VERSION = 1;
const TRANSITION_TIMEOUT_MS = 15_000;
const COMMAND_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 100;
const READY_PROBE_TIMEOUT_MS = 250;
const RETRY_MAX_MS = 500;
const SERVICE_NOT_FOUND = 113;
const TRANSITION_IN_PROGRESS = 5;
const OUTPUT_LIMIT = 4_096;
const DAEMON_DISABLED_CONTENT = "disabled by `prim daemon stop`\n";

export interface RuntimePathOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
}

export interface RuntimePaths {
  dataDir: string;
  runtimeDir: string;
  releasesDir: string;
  currentLink: string;
  statuslineLauncher: string;
  disabledMarker: string;
  lifecycleLockDir: string;
}

export interface RemoveDaemonRuntimeResult {
  changed: boolean;
  runtimePaths: RuntimePaths;
}

export interface RuntimeManifest {
  schemaVersion: number;
  version: string;
  nodePath: string;
  daemonFile: "prim-daemon-server";
  daemonSha256: string;
  stagedAt: string;
}

export interface StageRuntimeOptions extends RuntimePathOptions {
  nodePath?: string;
  daemonSource?: string | null;
  version?: string;
  now?: () => Date;
}

export interface StageRuntimeResult {
  changed: boolean;
  manifest: RuntimeManifest;
  paths: RuntimePaths;
  daemonPath: string;
}

export interface LaunchAgentConfig {
  launcherPath: string;
  logPath: string;
  workingDirectory: string;
  label?: string;
}

interface DaemonLauncherConfig {
  nodePath: string;
  daemonPath: string;
  runtimeVersion: string;
  apiUrl?: string;
  configDir?: string;
}

export interface LaunchctlResult {
  status: number | null;
  stdout: string;
  stderr: string;
  timedOut?: boolean;
}

export type LaunchctlRunner = (args: string[], timeoutMs?: number) => LaunchctlResult;

export type LaunchdService =
  | { loaded: false }
  | { loaded: true; state?: string; pid?: number; program?: string };

interface DaemonIdentity {
  pid: number;
  version?: string;
  launchRevision?: string;
}

class LaunchctlError extends Error {
  readonly status: number | null;
  readonly timedOut: boolean;

  constructor(operation: string, result: LaunchctlResult) {
    const stdout = result.stdout.slice(0, OUTPUT_LIMIT);
    const stderr = result.stderr.slice(0, OUTPUT_LIMIT);
    const raw = stderr.trim() || stdout.trim() || `exit ${String(result.status)}`;
    const detail =
      raw.replace(/\n?Try re-running the command as root for richer errors\.?/giu, "").trim() ||
      `exit ${String(result.status)}`;
    super(`launchctl ${operation} failed: ${detail}`);
    this.name = "LaunchctlError";
    this.status = result.status;
    this.timedOut = result.timedOut === true;
  }
}

export interface LaunchdPathOptions extends RuntimePathOptions {
  uid?: number;
  label?: string;
}

export interface LaunchdPaths {
  domainTarget: string;
  serviceTarget: string;
  plistPath: string;
  logPath: string;
}

export interface EnsureMacDaemonOptions extends StageRuntimeOptions, LaunchdPathOptions {
  runner?: LaunchctlRunner;
  inspectDaemon?: (timeoutMs: number) => Promise<DaemonIdentity | null>;
  validatePlist?: (path: string, timeoutMs: number) => void;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
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
    statuslineLauncher: join(runtimeDir, "prim-statusline"),
    disabledMarker: join(dataDir, "daemon.disabled"),
    lifecycleLockDir: join(dataDir, "daemon.lifecycle.lock"),
  };
}

function daemonControlPaths(options: RuntimePathOptions = {}) {
  const configDir = primConfigDirectory(options);
  const legacy = runtimePaths(options);
  return {
    launcher: join(configDir, `prim-daemon-launcher-v${LAUNCHER_SCHEMA_VERSION}`),
    disabledMarker: join(configDir, "daemon.disabled"),
    lifecycleLockDir: join(configDir, "daemon.lifecycle.lock"),
    legacyDisabledMarker: legacy.disabledMarker,
    legacyLifecycleLockDir: legacy.lifecycleLockDir,
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
      parsed.daemonFile !== "prim-daemon-server" ||
      typeof parsed.daemonSha256 !== "string" ||
      !/^[a-f0-9]{64}$/u.test(parsed.daemonSha256)
    ) {
      return null;
    }
    return parsed as RuntimeManifest;
  } catch {
    return null;
  }
}

const RUNTIME_RELEASE_RE = /^release-[0-9a-f]{16}$/u;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function readOwnedRuntimeManifest(releaseDir: string): RuntimeManifest | null {
  const manifestPath = join(releaseDir, "manifest.json");
  const daemonPath = join(releaseDir, "prim-daemon-server");
  try {
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (
      !exactKeys(parsed, [
        "schemaVersion",
        "version",
        "nodePath",
        "daemonFile",
        "daemonSha256",
        "stagedAt",
      ])
    ) {
      return null;
    }
    const manifest = parsed as RuntimeManifest;
    if (
      manifest.schemaVersion !== RUNTIME_SCHEMA_VERSION ||
      compareSemver(manifest.version, manifest.version) !== 0 ||
      !isAbsolute(manifest.nodePath) ||
      /[\r\n]/u.test(manifest.nodePath) ||
      manifest.daemonFile !== "prim-daemon-server" ||
      !/^[0-9a-f]{64}$/u.test(manifest.daemonSha256) ||
      new Date(manifest.stagedAt).toISOString() !== manifest.stagedAt ||
      raw !== `${JSON.stringify(manifest, null, 2)}\n` ||
      !lstatSync(daemonPath).isFile() ||
      sha256File(daemonPath) !== manifest.daemonSha256
    ) {
      return null;
    }
    const entries = readdirSync(releaseDir).sort();
    return entries.length === 2 &&
      entries[0] === "manifest.json" &&
      entries[1] === "prim-daemon-server"
      ? manifest
      : null;
  } catch {
    return null;
  }
}

function sameRuntime(
  current: RuntimeManifest | null,
  desired: RuntimeManifest,
  daemonPath: string,
): boolean {
  if (
    !current ||
    current.version !== desired.version ||
    current.nodePath !== desired.nodePath ||
    current.daemonSha256 !== desired.daemonSha256
  ) {
    return false;
  }
  try {
    return sha256File(daemonPath) === desired.daemonSha256;
  } catch {
    return false;
  }
}

function sha256File(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
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
 * Copy the standalone daemon entry into an immutable release directory,
 * then atomically repoint `runtime/current`. The manifest is written beside
 * it so the daemon can identify the staged version.
 */
export function stageRuntime(options: StageRuntimeOptions = {}): StageRuntimeResult {
  const paths = runtimePaths(options);
  const daemonSource = options.daemonSource ?? binFile("prim-daemon-server");
  if (!daemonSource || !existsSync(daemonSource)) {
    throw new Error("cannot stage runtime: prim-daemon-server bundle is unavailable");
  }
  const nodePath = resolve(options.nodePath ?? process.execPath);
  const version = options.version ?? findPackageVersion(daemonSource);
  const desired: RuntimeManifest = {
    schemaVersion: RUNTIME_SCHEMA_VERSION,
    version,
    nodePath,
    daemonFile: "prim-daemon-server",
    daemonSha256: sha256File(daemonSource),
    stagedAt: (options.now?.() ?? new Date()).toISOString(),
  };

  let currentRelease: string | null = null;
  try {
    currentRelease = realpathSync(paths.currentLink);
  } catch {
    // Missing or broken current selection is staged below.
  }
  const current = currentRelease
    ? readRuntimeManifest(join(currentRelease, "manifest.json"))
    : null;
  const currentDaemon = currentRelease ? join(currentRelease, desired.daemonFile) : "";
  if (currentRelease && sameRuntime(current, desired, currentDaemon)) {
    const manifest = current as RuntimeManifest;
    atomicWrite(
      paths.statuslineLauncher,
      statuslineLauncherContent(manifest.version, options),
      RUNTIME_LAUNCHER_MODE,
    );
    return {
      changed: false,
      manifest,
      paths,
      daemonPath: currentDaemon,
    };
  }

  mkdirSync(paths.releasesDir, { recursive: true, mode: RUNTIME_DIR_MODE });
  chmodSync(paths.runtimeDir, RUNTIME_DIR_MODE);
  chmodSync(paths.releasesDir, RUNTIME_DIR_MODE);

  const stagingDir = mkdtempSync(join(paths.releasesDir, ".stage-"));
  chmodSync(stagingDir, RUNTIME_DIR_MODE);
  let releaseDir: string;
  try {
    const daemonTarget = join(stagingDir, desired.daemonFile);
    copyFileSync(daemonSource, daemonTarget);
    chmodSync(daemonTarget, RUNTIME_FILE_MODE);
    if (sha256File(daemonTarget) !== desired.daemonSha256) {
      throw new Error("cannot stage runtime: daemon bundle changed while it was copied");
    }
    const manifestTarget = join(stagingDir, "manifest.json");
    writeFileSync(manifestTarget, `${JSON.stringify(desired, null, 2)}\n`, {
      encoding: "utf8",
      mode: RUNTIME_FILE_MODE,
      flag: "wx",
    });

    const releaseName = `release-${createHash("sha256")
      .update(`${version}\0${nodePath}\0${desired.stagedAt}\0${process.pid}\0${Math.random()}`)
      .digest("hex")
      .slice(0, 16)}`;
    releaseDir = join(paths.releasesDir, releaseName);
    renameSync(stagingDir, releaseDir);
    releaseDir = realpathSync(releaseDir);
    atomicSymlink(join("releases", releaseName), paths.currentLink);
    atomicWrite(
      paths.statuslineLauncher,
      statuslineLauncherContent(desired.version, options),
      RUNTIME_LAUNCHER_MODE,
    );
  } catch (error) {
    rmSync(stagingDir, { recursive: true, force: true });
    throw error;
  }

  return {
    changed: true,
    manifest: desired,
    paths,
    daemonPath: join(releaseDir, desired.daemonFile),
  };
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function statuslineLauncherContent(version: string, options: RuntimePathOptions = {}): string {
  const socketPath = join(primConfigDirectory(options), "sock");
  const fallback = `primitive ${version} (daemon: down)`;
  return `#!/bin/sh
response=$(
  printf 'prim-statusline-v1\\000%s\\000%s\\000' "\${PWD:-/}" "\${PRIM_API_URL:-}" |
    /usr/bin/nc -U -w 1 ${shellQuote(socketPath)} 2>/dev/null
)
status=$?
if [ "$status" -eq 0 ] && [ -n "$response" ]; then
  printf '%s' "$response"
else
  printf '%s' ${shellQuote(fallback)}
fi
`;
}

/** Pure command rendering; callers stage first, then persist this command. */
export function runtimeStatuslineCommand(options: RuntimePathOptions = {}): string {
  // Keep settings.json bytes stable across versions, machines, and XDG roots.
  // The resolver mirrors xdgDataHome(): only absolute XDG_DATA_HOME values are
  // honored, otherwise an absolute HOME is required.
  const resolver = `prim_data=\${XDG_DATA_HOME:-}; case "$prim_data" in /*) ;; *) case "\${HOME:-}" in /*) prim_data="$HOME/.local/share" ;; *) prim_data= ;; esac ;; esac; if [ -n "$prim_data" ] && [ -x "$prim_data/prim/runtime/prim-statusline" ]; then exec "$prim_data/prim/runtime/prim-statusline"; fi; exec ${stableHookCommand("prim-statusline")}`;
  return `/bin/sh -c ${shellQuote(resolver)} prim-statusline`;
}

function assertRegularFile(path: string, label: string): void {
  if (existsSync(path) && !lstatSync(path).isFile()) {
    throw new Error(`refusing to remove non-file ${label} at ${path}`);
  }
}

function assertExactFile(path: string, expected: string, label: string): void {
  if (!existsSync(path)) return;
  assertRegularFile(path, label);
  if (readFileSync(path, "utf8") !== expected) {
    throw new Error(`refusing to remove unrecognized ${label} at ${path}`);
  }
}

export function assertOwnedDaemonRuntime(options: LaunchdPathOptions): void {
  const runtime = runtimePaths(options);
  const control = daemonControlPaths(options);
  const service = launchdPaths(options);
  const configDir = primConfigDirectory(options);

  for (const activeArtifact of [
    join(configDir, "daemon.pid"),
    join(configDir, "sock"),
    join(configDir, "daemon.lock"),
    join(configDir, "client-instance.lock"),
  ]) {
    if (existsSync(activeArtifact)) {
      throw new Error(`refusing runtime removal while daemon state remains at ${activeArtifact}`);
    }
  }

  if (existsSync(control.launcher)) {
    assertRegularFile(control.launcher, "daemon launcher");
    if (!readDaemonLauncher(control.launcher)) {
      throw new Error(`refusing to remove unrecognized daemon launcher at ${control.launcher}`);
    }
  }
  assertExactFile(control.disabledMarker, DAEMON_DISABLED_CONTENT, "daemon disable marker");
  if (control.legacyDisabledMarker !== control.disabledMarker) {
    assertExactFile(
      control.legacyDisabledMarker,
      DAEMON_DISABLED_CONTENT,
      "legacy daemon disable marker",
    );
  }
  assertRegularFile(service.logPath, "daemon log");
  assertRegularFile(join(configDir, "daemon-health.json"), "daemon health snapshot");
  assertRegularFile(join(configDir, "client_instance_id"), "daemon client instance id");

  if (existsSync(service.plistPath)) {
    assertRegularFile(service.plistPath, "launchd property list");
    const expected = generateLaunchAgentPlist({
      launcherPath: control.launcher,
      logPath: service.logPath,
      workingDirectory: options.homeDir ?? homedir(),
      label: options.label,
    });
    if (readFileSync(service.plistPath, "utf8") !== expected) {
      throw new Error(
        `refusing to remove unrecognized launchd property list at ${service.plistPath}`,
      );
    }
  }

  if (!existsSync(runtime.runtimeDir)) return;
  if (!lstatSync(runtime.runtimeDir).isDirectory()) {
    throw new Error(`refusing to remove non-directory daemon runtime at ${runtime.runtimeDir}`);
  }
  const allowed = new Set(["current", "prim-statusline", "releases"]);
  const unexpected = readdirSync(runtime.runtimeDir).filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) {
    throw new Error(
      `refusing to remove daemon runtime with unrecognized entries: ${unexpected.sort().join(", ")}`,
    );
  }

  const manifests = new Map<string, RuntimeManifest>();
  if (existsSync(runtime.releasesDir)) {
    if (!lstatSync(runtime.releasesDir).isDirectory()) {
      throw new Error(`refusing to remove non-directory daemon releases at ${runtime.releasesDir}`);
    }
    for (const entry of readdirSync(runtime.releasesDir, { withFileTypes: true })) {
      const releaseDir = join(runtime.releasesDir, entry.name);
      const manifest =
        entry.isDirectory() && RUNTIME_RELEASE_RE.test(entry.name)
          ? readOwnedRuntimeManifest(releaseDir)
          : null;
      if (!manifest) {
        throw new Error(`refusing to remove unrecognized daemon release ${releaseDir}`);
      }
      manifests.set(entry.name, manifest);
    }
  }

  let selected: RuntimeManifest | undefined;
  if (existsSync(runtime.currentLink)) {
    if (!lstatSync(runtime.currentLink).isSymbolicLink()) {
      throw new Error(
        `refusing to remove malformed daemon runtime selector ${runtime.currentLink}`,
      );
    }
    const target = readlinkSync(runtime.currentLink);
    const releaseName = basename(target);
    if (target !== join("releases", releaseName) || !RUNTIME_RELEASE_RE.test(releaseName)) {
      throw new Error(
        `refusing to remove malformed daemon runtime selector ${runtime.currentLink}`,
      );
    }
    selected = manifests.get(releaseName);
    if (!selected) {
      throw new Error(`refusing to remove missing selected daemon release ${releaseName}`);
    }
  }
  if (existsSync(runtime.statuslineLauncher)) {
    if (!selected) {
      throw new Error(
        `refusing to remove daemon statusline without a selected runtime at ${runtime.statuslineLauncher}`,
      );
    }
    assertExactFile(
      runtime.statuslineLauncher,
      statuslineLauncherContent(selected.version, options),
      "daemon statusline launcher",
    );
  }
}

export type RemoveDaemonRuntimeOptions = LaunchdPathOptions & {
  lifecycleLock?: LifecycleLockControl;
};

/** Remove only stopped, schema-valid daemon/runtime artifacts owned by Prim. */
export async function removeDaemonRuntime(
  options: RemoveDaemonRuntimeOptions = {},
): Promise<RemoveDaemonRuntimeResult> {
  const runtime = runtimePaths(options);
  const control = daemonControlPaths(options);
  const service = launchdPaths(options);
  const configDir = primConfigDirectory(options);
  const ownedArtifacts = [
    runtime.runtimeDir,
    control.launcher,
    control.disabledMarker,
    control.legacyDisabledMarker,
    service.plistPath,
    service.logPath,
    join(configDir, "daemon-health.json"),
    join(configDir, "client_instance_id"),
  ];
  if (!ownedArtifacts.some((path) => existsSync(path))) {
    return { changed: false, runtimePaths: runtime };
  }

  return withDaemonLifecycleLock(async () => {
    assertOwnedDaemonRuntime(options);
    for (const path of ownedArtifacts.filter((candidate) => candidate !== runtime.runtimeDir)) {
      rmSync(path, { force: true });
    }
    if (existsSync(runtime.runtimeDir)) {
      const quarantined = `${runtime.runtimeDir}.uninstall-${String(process.pid)}-${randomBytes(8).toString("hex")}`;
      renameSync(runtime.runtimeDir, quarantined);
      rmSync(quarantined, { recursive: true, force: true });
    }
    return { changed: true, runtimePaths: runtime };
  }, options);
}

function generateDaemonLauncher(config: DaemonLauncherConfig) {
  const apiUrl = config.apiUrl ? normalizeApiUrl(config.apiUrl) || undefined : undefined;
  const metadata = {
    schemaVersion: LAUNCHER_SCHEMA_VERSION,
    nodePath: config.nodePath,
    daemonPath: config.daemonPath,
    runtimeVersion: config.runtimeVersion,
    apiUrl: apiUrl ?? null,
    ...(config.configDir ? { configDir: config.configDir } : {}),
  };
  const revision = createHash("sha256").update(JSON.stringify(metadata)).digest("hex");
  const encoded = Buffer.from(JSON.stringify({ ...metadata, revision })).toString("base64url");
  return {
    revision,
    content: `#!/bin/sh
# prim-daemon-launcher: ${encoded}
export PRIM_RUNTIME_VERSION=${shellQuote(config.runtimeVersion)}
export PRIM_LAUNCH_REVISION=${shellQuote(revision)}
${apiUrl ? `export PRIM_API_URL=${shellQuote(apiUrl)}` : "unset PRIM_API_URL"}
${config.configDir ? `export PRIM_CONFIG_DIR=${shellQuote(config.configDir)}\n` : ""}exec ${shellQuote(config.nodePath)} ${shellQuote(config.daemonPath)}
`,
  };
}

function readDaemonLauncher(path: string): DaemonLauncherConfig | null {
  try {
    const content = readFileSync(path, "utf8");
    const encoded = /^# prim-daemon-launcher: ([A-Za-z0-9_-]+)$/mu.exec(content)?.[1];
    if (!encoded) return null;
    const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      value.schemaVersion !== LAUNCHER_SCHEMA_VERSION ||
      typeof value.nodePath !== "string" ||
      typeof value.daemonPath !== "string" ||
      typeof value.runtimeVersion !== "string" ||
      (value.apiUrl !== null && typeof value.apiUrl !== "string") ||
      (value.configDir !== undefined &&
        (typeof value.configDir !== "string" || !isAbsolute(value.configDir))) ||
      typeof value.revision !== "string"
    ) {
      return null;
    }
    const config: DaemonLauncherConfig = {
      nodePath: value.nodePath,
      daemonPath: value.daemonPath,
      runtimeVersion: value.runtimeVersion,
      ...(value.apiUrl === null ? {} : { apiUrl: value.apiUrl }),
      ...(typeof value.configDir === "string" ? { configDir: value.configDir } : {}),
    };
    const expected = generateDaemonLauncher(config);
    return expected.revision === value.revision && expected.content === content ? config : null;
  } catch {
    return null;
  }
}

function readUsableDaemonConfig(path: string): DaemonLauncherConfig | null {
  const config = readDaemonLauncher(path);
  if (!config) return null;
  const manifest = readRuntimeManifest(join(dirname(config.daemonPath), "manifest.json"));
  try {
    accessSync(config.nodePath, constants.X_OK);
    return manifest?.version === config.runtimeVersion &&
      manifest.nodePath === config.nodePath &&
      manifest.daemonSha256 === sha256File(config.daemonPath)
      ? config
      : null;
  } catch {
    return null;
  }
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
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${xmlEscape(config.label ?? LAUNCHD_LABEL)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xmlEscape(config.launcherPath)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>ProcessType</key>
  <string>Background</string>
  <key>ExitTimeOut</key>
  <integer>5</integer>
  <key>Umask</key>
  <integer>63</integer>
  <key>WorkingDirectory</key>
  <string>${xmlEscape(config.workingDirectory)}</string>
  <key>StandardOutPath</key>
  <string>${xmlEscape(config.logPath)}</string>
  <key>StandardErrorPath</key>
  <string>${xmlEscape(config.logPath)}</string>
</dict>
</plist>
`;
}

export function launchdPaths(options: LaunchdPathOptions = {}): LaunchdPaths {
  const home = options.homeDir ?? homedir();
  const configDir = primConfigDirectory(options);
  const uid = options.uid ?? process.getuid?.();
  const label = options.label ?? LAUNCHD_LABEL;
  if (uid === undefined) throw new Error("cannot determine uid for launchd user domain");
  return {
    domainTarget: `gui/${uid}`,
    serviceTarget: `gui/${uid}/${label}`,
    plistPath: join(home, "Library", "LaunchAgents", `${label}.plist`),
    logPath: join(configDir, "daemon.log"),
  };
}

export const runLaunchctl: LaunchctlRunner = (args, timeoutMs = COMMAND_TIMEOUT_MS) => {
  const result = spawnSync("/bin/launchctl", args, { encoding: "utf8", timeout: timeoutMs });
  const error = result.error as NodeJS.ErrnoException | undefined;
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: error?.message ?? result.stderr ?? "",
    timedOut: error?.code === "ETIMEDOUT",
  };
};

/** Parse only stable, useful fields from `launchctl print`. */
export function parseLaunchdService(result: LaunchctlResult): LaunchdService {
  if (result.status === SERVICE_NOT_FOUND) return { loaded: false };
  if (result.status !== 0) throw new LaunchctlError("print", result);
  const state = /^\s*state = (.+?)\s*$/m.exec(result.stdout)?.[1];
  const rawPid = /^\s*pid = (\d+)\s*$/m.exec(result.stdout)?.[1];
  const program = /^\s*program = (.+?)\s*$/m.exec(result.stdout)?.[1];
  if (!program) throw new Error("launchctl print did not report the registered program");
  const pid = rawPid ? Number(rawPid) : undefined;
  return { loaded: true, state, pid, program };
}

export function getLaunchdService(
  options: LaunchdPathOptions & { runner?: LaunchctlRunner; timeoutMs?: number } = {},
): LaunchdService {
  return parseLaunchdService(
    (options.runner ?? runLaunchctl)(
      ["print", launchdPaths(options).serviceTarget],
      options.timeoutMs ?? COMMAND_TIMEOUT_MS,
    ),
  );
}

function atomicWrite(
  path: string,
  content: string,
  mode: number,
  validate?: (path: string, timeoutMs: number) => void,
): boolean {
  try {
    if (readFileSync(path, "utf8") === content) {
      chmodSync(path, mode);
      validate?.(path, COMMAND_TIMEOUT_MS);
      return false;
    }
  } catch {
    // Missing or unreadable: replace it below.
  }
  mkdirSync(dirname(path), { recursive: true, mode: RUNTIME_DIR_MODE });
  const temp = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temp, content, { encoding: "utf8", mode, flag: "wx" });
  try {
    validate?.(temp, COMMAND_TIMEOUT_MS);
    renameSync(temp, path);
  } catch (error) {
    rmSync(temp, { force: true });
    throw error;
  }
  return true;
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function validatePlist(path: string, timeoutMs: number): void {
  if (process.platform !== "darwin") return;
  const result = spawnSync("/usr/bin/plutil", ["-lint", path], {
    encoding: "utf8",
    timeout: timeoutMs,
  });
  if (result.status !== 0) {
    throw new Error(
      `invalid launchd plist: ${
        result.error?.message ??
        result.stderr?.trim() ??
        result.stdout?.trim() ??
        `exit ${String(result.status)}`
      }`,
    );
  }
}

async function inspectDaemon(timeoutMs: number): Promise<DaemonIdentity | null> {
  const value = await daemonRequest<Partial<DaemonIdentity>>("status_snapshot", {}, { timeoutMs });
  if (!value || !Number.isInteger(value.pid) || (value.pid ?? 0) <= 0) return null;
  return value as DaemonIdentity;
}

function canonicalProspectivePath(path: string): string {
  const suffix: string[] = [];
  let ancestor = resolve(path);
  while (!existsSync(ancestor)) {
    const parent = dirname(ancestor);
    if (parent === ancestor) return resolve(path);
    suffix.unshift(basename(ancestor));
    ancestor = parent;
  }
  try {
    return join(realpathSync(ancestor), ...suffix);
  } catch {
    return resolve(path);
  }
}

/** Serialize daemon lifecycle mutation across concurrent agent sessions. */
export async function withDaemonLifecycleLock<T>(
  operation: () => Promise<T>,
  options: RuntimePathOptions & { lifecycleLock?: LifecycleLockControl } = {},
): Promise<T> {
  const paths = daemonControlPaths(options);
  const sameLock =
    canonicalProspectivePath(paths.lifecycleLockDir) ===
    canonicalProspectivePath(paths.legacyLifecycleLockDir);
  return withFileLock(
    paths.lifecycleLockDir,
    () =>
      sameLock
        ? operation()
        : withFileLock(paths.legacyLifecycleLockDir, operation, options.lifecycleLock),
    options.lifecycleLock,
  );
}

async function stopVerifiedLegacyDaemon(
  options: RuntimePathOptions,
  deadlineMs: number,
  nowMs: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const pidPath = join(primConfigDirectory(options), "daemon.pid");
  let pid: number;
  try {
    pid = Number(readFileSync(pidPath, "utf8").trim());
  } catch {
    throw new Error("an unsupervised daemon answered, but it has no verifiable pidfile");
  }
  if (nowMs() >= deadlineMs) throw new Error("legacy verification exceeded the lifecycle deadline");
  const snapshot = await daemonRequest<{ pid?: number }>(
    "status_snapshot",
    {},
    {
      timeoutMs: timeoutMs(nowMs, deadlineMs, 500),
    },
  );
  if (!Number.isInteger(pid) || pid <= 0 || !processIsAlive(pid) || snapshot?.pid !== pid) {
    throw new Error("refusing to signal an unsupervised daemon whose pid cannot be verified");
  }
  if (nowMs() >= deadlineMs) throw new Error("legacy verification exceeded the lifecycle deadline");
  process.kill(pid, "SIGTERM");
  while (nowMs() < deadlineMs && processIsAlive(pid)) {
    await sleep(Math.min(READY_POLL_MS, deadlineMs - nowMs()));
  }
  if (processIsAlive(pid)) {
    throw new Error(`verified legacy daemon pid=${pid} did not stop before the lifecycle deadline`);
  }
  return true;
}

function timeoutMs(nowMs: () => number, deadlineMs: number, cap = COMMAND_TIMEOUT_MS): number {
  return Math.max(1, Math.min(cap, Math.ceil(deadlineMs - nowMs())));
}

interface Transition {
  paths: LaunchdPaths;
  runner: LaunchctlRunner;
  inspect: (timeoutMs: number) => Promise<DaemonIdentity | null>;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  deadlineMs: number;
  launcherPath: string;
  version: string;
  revision: string;
}

interface Observation {
  service: LaunchdService;
  identity: DaemonIdentity | null;
}

function desiredDaemonIsRunning(transition: Transition, observed: Observation): boolean {
  const { service, identity } = observed;
  return Boolean(
    service.loaded &&
      service.program === transition.launcherPath &&
      service.pid !== undefined &&
      identity?.pid === service.pid &&
      identity.version === transition.version &&
      identity.launchRevision === transition.revision,
  );
}

function getService(transition: Transition): LaunchdService {
  return parseLaunchdService(
    transition.runner(
      ["print", transition.paths.serviceTarget],
      timeoutMs(transition.nowMs, transition.deadlineMs),
    ),
  );
}

async function observe(transition: Transition): Promise<Observation> {
  const service = getService(transition);
  const identity =
    service.loaded && service.program === transition.launcherPath
      ? await transition.inspect(
          timeoutMs(transition.nowMs, transition.deadlineMs, READY_PROBE_TIMEOUT_MS),
        )
      : null;
  return { service, identity };
}

async function tryObserve(transition: Transition): Promise<Observation | null> {
  try {
    return await observe(transition);
  } catch (error) {
    if (!(error instanceof LaunchctlError)) throw error;
    return null;
  }
}

async function bootstrap(transition: Transition, oldProgram?: string): Promise<void> {
  let retryMs = READY_POLL_MS;
  let lastError: LaunchctlError | null = null;
  while (transition.nowMs() < transition.deadlineMs) {
    const result = transition.runner(
      ["bootstrap", transition.paths.domainTarget, transition.paths.plistPath],
      timeoutMs(transition.nowMs, transition.deadlineMs),
    );
    if (result.status === 0) return;
    const error = new LaunchctlError("bootstrap", result);
    lastError = error;
    const observed = await tryObserve(transition);
    const retryable = error.status === TRANSITION_IN_PROGRESS || error.timedOut;
    if (observed?.service.loaded) {
      if (observed.service.program === transition.launcherPath) {
        if (desiredDaemonIsRunning(transition, observed)) return;
        if (retryable) return;
      } else if (observed.service.program !== oldProgram) {
        throw new Error(
          `refusing to replace unexpected launchd program ${observed.service.program}`,
        );
      }
    }
    if (!retryable) throw error;
    const remaining = transition.deadlineMs - transition.nowMs();
    if (remaining <= 0) break;
    await transition.sleep(Math.min(retryMs, remaining));
    retryMs = Math.min(retryMs * 2, RETRY_MAX_MS);
  }
  throw new Error(
    `launchctl bootstrap did not converge within ${TRANSITION_TIMEOUT_MS}ms${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}

async function reloadDefinition(transition: Transition, oldProgram: string): Promise<void> {
  const result = transition.runner(
    ["bootout", transition.paths.serviceTarget],
    timeoutMs(transition.nowMs, transition.deadlineMs),
  );
  if (result.status !== 0) {
    const error = new LaunchctlError("bootout", result);
    const observed = await tryObserve(transition);
    const retryable = error.status === TRANSITION_IN_PROGRESS || error.timedOut;
    if (observed?.service.loaded) {
      if (observed.service.program === transition.launcherPath) {
        if (desiredDaemonIsRunning(transition, observed)) return;
        if (retryable) return;
      }
      if (observed.service.program !== oldProgram || !retryable) throw error;
    } else if (!observed && !retryable) {
      throw error;
    }
  }
  await bootstrap(transition, oldProgram);
}

async function waitForDesired(
  transition: Transition,
  repairMismatch = false,
): Promise<Observation> {
  let observed: Observation = { service: { loaded: false }, identity: null };
  let repaired = false;
  do {
    const current = await tryObserve(transition);
    if (current) {
      observed = current;
      if (desiredDaemonIsRunning(transition, observed)) return observed;
      if (observed.service.loaded && observed.service.program !== transition.launcherPath) {
        throw new Error(`launchd registered unexpected program ${observed.service.program}`);
      }
      if (
        repairMismatch &&
        !repaired &&
        observed.service.loaded &&
        observed.service.program === transition.launcherPath &&
        observed.identity
      ) {
        repaired = true;
        await kickstart(transition);
      }
    }
    const remaining = transition.deadlineMs - transition.nowMs();
    if (remaining <= 0) break;
    await transition.sleep(Math.min(READY_POLL_MS, remaining));
  } while (transition.nowMs() < transition.deadlineMs);
  return observed;
}

async function kickstart(transition: Transition): Promise<void> {
  const result = transition.runner(
    ["kickstart", "-k", transition.paths.serviceTarget],
    timeoutMs(transition.nowMs, transition.deadlineMs),
  );
  if (result.status === 0) return;
  const error = new LaunchctlError("kickstart", result);
  const observed = await tryObserve(transition);
  if (observed && desiredDaemonIsRunning(transition, observed)) return;
  if (!error.timedOut) throw error;
  const ready = await waitForDesired(transition);
  if (!desiredDaemonIsRunning(transition, ready)) throw error;
}

async function waitForAbsence(context: {
  options: LaunchdPathOptions;
  runner: LaunchctlRunner;
  inspect: (timeoutMs: number) => Promise<DaemonIdentity | null>;
  sleep: (ms: number) => Promise<void>;
  nowMs: () => number;
  deadlineMs: number;
  previousPid?: number;
}): Promise<void> {
  let lastError: LaunchctlError | null = null;
  while (context.nowMs() < context.deadlineMs) {
    try {
      const service = getLaunchdService({
        ...context.options,
        runner: context.runner,
        timeoutMs: timeoutMs(context.nowMs, context.deadlineMs),
      });
      if (!service.loaded) {
        const identity = await context.inspect(
          timeoutMs(context.nowMs, context.deadlineMs, READY_PROBE_TIMEOUT_MS),
        );
        const socketReleased =
          context.previousPid === undefined || identity?.pid !== context.previousPid;
        const processExited =
          context.previousPid === undefined || !processIsAlive(context.previousPid);
        if (socketReleased && processExited) return;
      }
    } catch (error) {
      if (!(error instanceof LaunchctlError)) throw error;
      lastError = error;
    }
    const remaining = context.deadlineMs - context.nowMs();
    if (remaining <= 0) break;
    await context.sleep(Math.min(READY_POLL_MS, remaining));
  }
  throw new Error(
    `launchctl bootout did not converge within ${TRANSITION_TIMEOUT_MS}ms${
      lastError ? `: ${lastError.message}` : ""
    }`,
  );
}

export function daemonExplicitlyDisabled(options: RuntimePathOptions = {}): boolean {
  const paths = daemonControlPaths(options);
  return existsSync(paths.disabledMarker) || existsSync(paths.legacyDisabledMarker);
}

export function setDaemonExplicitlyDisabled(
  disabled: boolean,
  options: RuntimePathOptions = {},
): void {
  const paths = daemonControlPaths(options);
  if (!disabled) {
    rmSync(paths.disabledMarker, { force: true });
    rmSync(paths.legacyDisabledMarker, { force: true });
    return;
  }
  const content = DAEMON_DISABLED_CONTENT;
  if (paths.legacyDisabledMarker !== paths.disabledMarker) {
    atomicWrite(paths.legacyDisabledMarker, content, RUNTIME_FILE_MODE);
  }
  atomicWrite(paths.disabledMarker, content, RUNTIME_FILE_MODE);
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
  const runner = options.runner ?? runLaunchctl;
  let service = getLaunchdService({ ...options, runner });
  if (!options.explicitlyStarted && daemonExplicitlyDisabled(options)) {
    const control = daemonControlPaths(options);
    if (!existsSync(control.disabledMarker)) {
      atomicWrite(control.disabledMarker, "disabled by `prim daemon stop`\n", RUNTIME_FILE_MODE);
    }
    return {
      state: "disabled",
      action: "none",
      runtimeChanged: false,
      plistChanged: false,
      responding: false,
      service,
    };
  }
  if (options.explicitlyStarted) setDaemonExplicitlyDisabled(false, options);

  const control = daemonControlPaths(options);
  const requestedSource = options.daemonSource ?? binFile("prim-daemon-server");
  if (!options.version && !requestedSource) {
    throw new Error("cannot determine runtime version: daemon is unavailable");
  }
  const requestedVersion = options.version ?? findPackageVersion(requestedSource as string);
  const selected = options.explicitlyStarted ? null : readDaemonLauncher(control.launcher);
  const precedence = selected ? compareSemver(selected.runtimeVersion, requestedVersion) : null;
  const retainSelected =
    selected !== null &&
    (precedence === 1 ||
      (precedence === undefined && selected.runtimeVersion !== requestedVersion));
  let runtime: StageRuntimeResult | undefined;
  let daemonConfig: DaemonLauncherConfig;
  const configuredApiUrl = (options.env ?? process.env).PRIM_API_URL;
  const apiUrl = configuredApiUrl ? normalizeApiUrl(configuredApiUrl) || undefined : undefined;
  const configDir = primConfigDirectory(options);
  const legacyDefaultConfigDir = join(options.homeDir ?? homedir(), ".config", "prim");
  // Keep the default-root schema-v1 launcher byte-compatible with older CLIs.
  // A custom root needs to be exported because the daemon cannot infer it.
  const launcherConfigDir = configDir === legacyDefaultConfigDir ? undefined : configDir;
  if (retainSelected && selected) {
    const usable = readUsableDaemonConfig(control.launcher);
    if (!usable) {
      throw new Error(
        `selected daemon runtime ${selected.runtimeVersion} is unavailable or corrupt; refusing automatic downgrade to ${requestedVersion}`,
      );
    }
    daemonConfig = {
      nodePath: usable.nodePath,
      daemonPath: usable.daemonPath,
      runtimeVersion: usable.runtimeVersion,
      ...(apiUrl ? { apiUrl } : {}),
      ...(launcherConfigDir ? { configDir: launcherConfigDir } : {}),
    };
  } else {
    runtime = stageRuntime({ ...options, version: requestedVersion });
    daemonConfig = {
      nodePath: runtime.manifest.nodePath,
      daemonPath: runtime.daemonPath,
      runtimeVersion: runtime.manifest.version,
      ...(apiUrl ? { apiUrl } : {}),
      ...(launcherConfigDir ? { configDir: launcherConfigDir } : {}),
    };
  }

  const servicePaths = launchdPaths(options);
  mkdirSync(dirname(servicePaths.logPath), { recursive: true, mode: RUNTIME_DIR_MODE });
  writeFileSync(servicePaths.logPath, "", { mode: RUNTIME_FILE_MODE, flag: "a" });
  chmodSync(servicePaths.logPath, RUNTIME_FILE_MODE);
  const launcher = generateDaemonLauncher(daemonConfig);
  atomicWrite(control.launcher, launcher.content, RUNTIME_LAUNCHER_MODE);
  const plist = generateLaunchAgentPlist({
    launcherPath: control.launcher,
    logPath: servicePaths.logPath,
    workingDirectory: options.homeDir ?? homedir(),
    label: options.label,
  });
  const plistChanged = atomicWrite(
    servicePaths.plistPath,
    plist,
    PLIST_FILE_MODE,
    options.validatePlist ?? validatePlist,
  );
  const sleep = options.sleep ?? defaultSleep;
  const nowMs = options.nowMs ?? performance.now.bind(performance);
  const deadlineMs = nowMs() + TRANSITION_TIMEOUT_MS;
  const inspect = options.inspectDaemon ?? inspectDaemon;
  const transition: Transition = {
    paths: servicePaths,
    runner,
    inspect,
    sleep,
    nowMs,
    deadlineMs,
    launcherPath: control.launcher,
    version: daemonConfig.runtimeVersion,
    revision: launcher.revision,
  };
  const migrateLegacy =
    options.migrateLegacy ?? (() => stopVerifiedLegacyDaemon(options, deadlineMs, nowMs, sleep));
  let action: EnsureMacDaemonResult["action"] = "none";

  const observed = await observe(transition);
  service = observed.service;
  if (!service.loaded) {
    if (await inspect(timeoutMs(nowMs, deadlineMs, READY_PROBE_TIMEOUT_MS))) {
      await migrateLegacy();
    }
    await bootstrap(transition);
    action = "bootstrap";
  } else if (service.program !== control.launcher) {
    if (!service.program) throw new Error("launchd did not report the registered program");
    await reloadDefinition(transition, service.program);
    action = "reload";
  } else if (options.forceRestart || !desiredDaemonIsRunning(transition, observed)) {
    await kickstart(transition);
    action = "kickstart";
  }

  const ready = await waitForDesired(transition, action === "bootstrap" || action === "reload");
  service = ready.service;
  const responding = ready.identity !== null;
  const running = desiredDaemonIsRunning(transition, ready);
  return {
    state: running ? "running" : "unhealthy",
    action,
    runtimeChanged: runtime?.changed ?? false,
    plistChanged,
    responding,
    ...(ready.identity ? { socketPid: ready.identity.pid } : {}),
    service,
    ...(runtime ? { runtime } : {}),
  };
}

/** Stop the loaded service; migrate-stop a verified legacy detached daemon. */
export async function bootoutMacDaemon(
  options: BootoutMacDaemonOptions = {},
): Promise<{ wasLoaded: boolean; legacyStopped: boolean; service: LaunchdService }> {
  return withDaemonLifecycleLock(() => bootoutMacDaemonLocked(options), options);
}

interface BootoutMacDaemonOptions extends LaunchdPathOptions {
  runner?: LaunchctlRunner;
  inspectDaemon?: (timeoutMs: number) => Promise<DaemonIdentity | null>;
  migrateLegacy?: () => Promise<boolean>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
  lifecycleLock?: LifecycleLockControl;
}

async function bootoutMacDaemonLocked(
  options: BootoutMacDaemonOptions,
): Promise<{ wasLoaded: boolean; legacyStopped: boolean; service: LaunchdService }> {
  setDaemonExplicitlyDisabled(true, options);
  const runner = options.runner ?? runLaunchctl;
  const inspect = options.inspectDaemon ?? inspectDaemon;
  const sleep = options.sleep ?? defaultSleep;
  const nowMs = options.nowMs ?? performance.now.bind(performance);
  const deadlineMs = nowMs() + TRANSITION_TIMEOUT_MS;
  const paths = launchdPaths(options);
  const migrateLegacy =
    options.migrateLegacy ?? (() => stopVerifiedLegacyDaemon(options, deadlineMs, nowMs, sleep));
  const service = getLaunchdService({ ...options, runner });
  const wasLoaded = service.loaded;
  if (wasLoaded) {
    const result = runner(["bootout", paths.serviceTarget], timeoutMs(nowMs, deadlineMs));
    if (result.status !== 0) {
      const error = new LaunchctlError("bootout", result);
      const after = getLaunchdService({
        ...options,
        runner,
        timeoutMs: timeoutMs(nowMs, deadlineMs),
      });
      if (!error.timedOut && error.status !== TRANSITION_IN_PROGRESS && after.loaded) {
        throw error;
      }
    }
    await waitForAbsence({
      options,
      runner,
      inspect,
      sleep,
      nowMs,
      deadlineMs,
      previousPid: service.pid,
    });
  }
  const legacy = await inspect(timeoutMs(nowMs, deadlineMs, READY_PROBE_TIMEOUT_MS));
  let legacyStopped = false;
  if (legacy) {
    legacyStopped = await migrateLegacy();
    if (!legacyStopped) {
      throw new Error(`legacy daemon pid=${legacy.pid} could not be verified stopped`);
    }
    if (await inspect(timeoutMs(nowMs, deadlineMs, READY_PROBE_TIMEOUT_MS))) {
      throw new Error("legacy daemon remained present after stop");
    }
  }
  return { wasLoaded, legacyStopped, service };
}
