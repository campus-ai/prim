/**
 * `prim daemon start | stop | status | restart` — the long-lived prim
 * companion process.
 *
 * Lifecycle:
 *   prim daemon start                supervise with launchd on macOS
 *   prim daemon start --foreground   run inline (or detached fallback elsewhere)
 *   prim daemon stop                 bootout on macOS; verified SIGTERM elsewhere
 *   prim daemon status               liveness probe + status snapshot
 *   prim daemon restart              supervised kickstart/reload on macOS
 *   prim daemon ensure               repair unless explicitly disabled
 *
 * The daemon binary is `prim-daemon-server`, installed alongside the
 * other bins by `npm i -g @primitive.ai/prim`. In a dev checkout you
 * must `pnpm build` then ensure the bin resolves on PATH (typically
 * via `pnpm link --global` or a `dist/daemon/server.js` shim).
 *
 * AX contract: STDERR verdict-first; STDOUT machine-readable JSON.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { daemonIsLive, daemonRequest } from "../daemon/client.js";
import type { DaemonHeartbeatHealth, DaemonIngestionHealth } from "../daemon/health.js";
import {
  type LaunchdService,
  bootoutMacDaemon,
  daemonExplicitlyDisabled,
  ensureMacDaemon,
  getLaunchdService,
  setDaemonExplicitlyDisabled,
  withDaemonLifecycleLock,
} from "../daemon/launchd.js";
import { stripControlChars } from "../lib/ansi.js";
import { binFile } from "../lib/bin-path.js";
import { type Teammate, formatTeammates } from "../lib/presence.js";

const DAEMON_BIN = "prim-daemon-server";
const CONFIG_DIR = join(homedir(), ".config", "prim");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");
const SOCK_PATH = join(CONFIG_DIR, "sock");
const LOG_PATH = join(CONFIG_DIR, "daemon.log");

const CONFIG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 100;
const STATUS_PROBE_TIMEOUT_MS = 500;
// `start` polls the socket — the real readiness signal — until the daemon
// answers a ping, instead of peeking the pidfile once. The server writes its
// pidfile BEFORE it binds the socket (server.ts), and a cold Node start can
// outlast a single short wait, so the old 400ms pidfile peek raced boot and
// reported a healthy, still-starting daemon as "down". Poll up to the deadline.
const READY_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 100;
const READY_PROBE_TIMEOUT_MS = 250;
const HEALTHY_TIMEOUT_MS = 30_000;
const HEALTHY_POLL_MS = 250;
const EXIT_OK = 0;
const EXIT_NOT_RUNNING = 2;
// Pidfile alive but the socket isn't answering yet — booting (or wedged),
// distinct from hard-down so an agent can retry rather than treat it as failed.
const EXIT_BOOTING = 3;

interface RunningPid {
  pid: number;
  alive: boolean;
}

interface StatusSnapshot {
  pid: number;
  uptimeMs: number;
  sessionId: string;
  lastHeartbeatAt?: number;
  healthy?: boolean;
  needsReauth?: boolean;
  heartbeat?: DaemonHeartbeatHealth;
  ingestion?: DaemonIngestionHealth;
  version?: string;
  onlineCount?: number;
  // Online teammates (self excluded), sorted. Surfaced in full here, where
  // there's room; the statusline truncates the same list.
  onlineNames?: string[];
  onlineTeammates?: Teammate[];
}

const MAX_HEALTH_ERROR_LENGTH = 240;

function boundedHealthError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = stripControlChars(value).replace(/\s+/g, " ").trim();
  if (!clean) return undefined;
  return clean.length <= MAX_HEALTH_ERROR_LENGTH
    ? clean
    : `${clean.slice(0, MAX_HEALTH_ERROR_LENGTH - 1)}\u2026`;
}

/** Render the single most actionable cause of a degraded daemon snapshot. */
export function daemonDegradedReason(snapshot: StatusSnapshot | null): string | undefined {
  if (!snapshot || snapshot.healthy !== false) return undefined;
  if (snapshot.needsReauth) {
    return "authentication requires `prim auth login`";
  }
  if (snapshot.heartbeat?.healthy === false) {
    const detail = boundedHealthError(snapshot.heartbeat.lastError);
    return `heartbeat unhealthy${detail ? `: ${detail}` : ""}`;
  }
  if (snapshot.ingestion?.healthy === false) {
    const detail = boundedHealthError(snapshot.ingestion.lastError);
    const pending = snapshot.ingestion.pendingCount;
    const qualifier = snapshot.ingestion.pendingSampled ? "at least " : "";
    return `ingestion unhealthy${typeof pending === "number" ? ` (${qualifier}${String(pending)} pending)` : ""}${detail ? `: ${detail}` : ""}`;
  }
  return "health checks have not recovered";
}

function readPidfile(): RunningPid | null {
  if (!existsSync(PID_PATH)) {
    return null;
  }
  const raw = readFileSync(PID_PATH, "utf-8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return { pid, alive: processIsAlive(pid) };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStaleArtifacts(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    // pidfile already gone
  }
  try {
    unlinkSync(SOCK_PATH);
  } catch {
    // socket already gone
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Spawn the daemon server by absolute path (`<node> <abs>/server.js`) so it
 * resolves regardless of PATH; fall back to the bare bin name for dev checkouts
 * that link it onto PATH (`pnpm link --global`).
 */
function spawnDaemon(options: SpawnOptions) {
  const file = binFile(DAEMON_BIN);
  return file ? spawn(process.execPath, [file], options) : spawn(DAEMON_BIN, [], options);
}

/**
 * Open the daemon log for appending (creating the config dir if needed) so
 * the detached daemon can inherit it as stdout+stderr. The daemon already
 * writes its lifecycle and crash lines to those streams; without a real file
 * the detached spawn sent them to /dev/null, leaving a crash with no trace on
 * disk. Returns the fd; the caller closes its own copy after handing it to
 * the child.
 */
export function openDaemonLog(configDir: string = CONFIG_DIR): number {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: CONFIG_DIR_MODE });
  }
  return openSync(join(configDir, "daemon.log"), "a", LOG_FILE_MODE);
}

/** Poll the socket until the daemon answers a ping or the deadline elapses. */
async function waitForReady(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await daemonIsLive(READY_PROBE_TIMEOUT_MS)) {
      return true;
    }
    await sleep(READY_POLL_MS);
  }
  return daemonIsLive(READY_PROBE_TIMEOUT_MS);
}

async function waitForHealthySnapshot(expectedVersion: string): Promise<StatusSnapshot | null> {
  const deadline = Date.now() + HEALTHY_TIMEOUT_MS;
  let snapshot: StatusSnapshot | null = null;
  while (Date.now() < deadline) {
    snapshot = await daemonRequest<StatusSnapshot>(
      "status_snapshot",
      {},
      { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
    );
    if (snapshot?.healthy === true && snapshot.version === expectedVersion) return snapshot;
    await sleep(HEALTHY_POLL_MS);
  }
  return snapshot;
}

async function verifiedPid(existing: RunningPid): Promise<StatusSnapshot | null> {
  if (!existing.alive) return null;
  const snapshot = await daemonRequest<StatusSnapshot>(
    "status_snapshot",
    {},
    { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
  );
  return snapshot?.pid === existing.pid ? snapshot : null;
}

export function daemonStartIsHealthy(
  serviceReady: boolean,
  snapshot: Pick<StatusSnapshot, "healthy" | "version"> | null,
  expectedVersion: string | undefined,
): boolean {
  return (
    serviceReady &&
    snapshot?.healthy === true &&
    expectedVersion !== undefined &&
    snapshot.version === expectedVersion
  );
}

export function daemonStartHealthFields(
  healthy: boolean,
  snapshot: StatusSnapshot | null,
): Record<string, unknown> {
  if (healthy) return {};
  return {
    state: "degraded",
    needsReauth: snapshot?.needsReauth === true,
    heartbeat: snapshot?.heartbeat ?? null,
    ingestion: snapshot?.ingestion ?? null,
  };
}

async function detachedDaemonStart(opts: { foreground?: boolean }): Promise<void> {
  const existing = readPidfile();
  if (existing?.alive) {
    const snapshot = await verifiedPid(existing);
    if (snapshot) {
      process.stderr.write(`[prim] daemon already running (pid=${existing.pid})\n`);
      console.log(JSON.stringify({ started: false, pid: existing.pid }, null, 2));
      return;
    }
    process.stderr.write(
      `[prim] refusing to replace live pid=${existing.pid}: daemon ownership could not be verified over ${SOCK_PATH}\n`,
    );
    console.log(JSON.stringify({ started: false, pid: existing.pid, verified: false }, null, 2));
    if (!process.exitCode) process.exitCode = EXIT_BOOTING;
    return;
  }
  if (existing && !existing.alive) {
    const socketOwner = await daemonRequest<StatusSnapshot>(
      "status_snapshot",
      {},
      { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
    );
    if (socketOwner) {
      process.stderr.write(
        `[prim] refusing to clear stale pidfile: socket is owned by pid=${socketOwner.pid}\n`,
      );
      console.log(
        JSON.stringify({ started: false, pid: socketOwner.pid, verified: false }, null, 2),
      );
      if (!process.exitCode) process.exitCode = EXIT_BOOTING;
      return;
    }
    clearStaleArtifacts();
  }

  if (opts.foreground) {
    // Inherit all stdio so the user sees the daemon's lifecycle log.
    const child = spawnDaemon({ stdio: "inherit" });
    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  // Hand the detached child an append fd to ~/.config/prim/daemon.log for
  // stdout+stderr so its heartbeat/crash lines survive instead of going to
  // /dev/null. Fail-soft: if the log can't be opened, discard rather than
  // block startup.
  let logFd: number | undefined;
  try {
    logFd = openDaemonLog();
  } catch {
    logFd = undefined;
  }
  const child = spawnDaemon({
    detached: true,
    stdio: logFd === undefined ? ["ignore", "ignore", "ignore"] : ["ignore", logFd, logFd],
  });
  child.unref();
  if (logFd !== undefined) {
    closeSync(logFd);
  }

  // Block until the daemon actually answers on its socket — the only signal
  // that it's ready to serve — so a chained `status` can't race the boot.
  const live = await waitForReady();
  if (live) {
    const after = readPidfile();
    process.stderr.write(
      `[prim] ✓ daemon started (pid=${after?.pid ?? "?"}, socket=${SOCK_PATH})\n`,
    );
    console.log(JSON.stringify({ started: true, pid: after?.pid }, null, 2));
    return;
  }
  process.stderr.write(
    `[prim] ✗ daemon start: spawned but the socket did not respond within ${READY_TIMEOUT_MS}ms (check that \`${DAEMON_BIN}\` resolves, and see ${LOG_PATH})\n`,
  );
  console.log(JSON.stringify({ started: false }, null, 2));
  if (!process.exitCode) {
    process.exitCode = EXIT_NOT_RUNNING;
  }
}

async function detachedDaemonStop(): Promise<void> {
  const existing = readPidfile();
  if (!existing) {
    process.stderr.write("[prim] daemon not running (no pidfile)\n");
    console.log(JSON.stringify({ stopped: false, wasRunning: false }, null, 2));
    return;
  }
  if (!existing.alive) {
    const socketOwner = await daemonRequest<StatusSnapshot>(
      "status_snapshot",
      {},
      { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
    );
    if (socketOwner) {
      process.stderr.write(
        `[prim] refusing to clear stale pidfile: socket is owned by pid=${socketOwner.pid}\n`,
      );
      console.log(
        JSON.stringify({ stopped: false, pid: socketOwner.pid, verified: false }, null, 2),
      );
      return;
    }
    clearStaleArtifacts();
    process.stderr.write("[prim] daemon not running (cleared stale pidfile)\n");
    console.log(JSON.stringify({ stopped: false, wasRunning: false }, null, 2));
    return;
  }
  const snapshot = await verifiedPid(existing);
  if (!snapshot) {
    process.stderr.write(
      `[prim] refusing to signal live pid=${existing.pid}: daemon ownership could not be verified over ${SOCK_PATH}\n`,
    );
    console.log(JSON.stringify({ stopped: false, pid: existing.pid, verified: false }, null, 2));
    if (!process.exitCode) process.exitCode = EXIT_BOOTING;
    return;
  }
  try {
    process.kill(existing.pid, "SIGTERM");
  } catch (err) {
    process.stderr.write(
      `[prim] could not signal pid=${existing.pid}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    console.log(JSON.stringify({ stopped: false, pid: existing.pid }, null, 2));
    return;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(existing.pid)) {
      clearStaleArtifacts();
      process.stderr.write(`[prim] daemon stopped (pid=${existing.pid})\n`);
      console.log(JSON.stringify({ stopped: true, pid: existing.pid }, null, 2));
      return;
    }
    await sleep(STOP_POLL_MS);
  }
  process.stderr.write(
    `[prim] daemon did not exit within ${STOP_TIMEOUT_MS}ms (pid=${existing.pid} still alive)\n`,
  );
  console.log(JSON.stringify({ stopped: false, pid: existing.pid }, null, 2));
  if (!process.exitCode) process.exitCode = EXIT_BOOTING;
}

async function macDaemonStart(forceRestart = false): Promise<void> {
  const result = await ensureMacDaemon({ explicitlyStarted: true, forceRestart });
  const serviceReady = result.state === "running";
  const expectedVersion = result.runtime?.manifest.version;
  const snapshot =
    serviceReady && expectedVersion ? await waitForHealthySnapshot(expectedVersion) : null;
  const healthy = daemonStartIsHealthy(serviceReady, snapshot, expectedVersion);
  if (healthy) {
    const verb = result.action === "none" ? "already running" : "started";
    process.stderr.write(
      `[prim] ✓ daemon ${verb} under launchd (pid=${snapshot?.pid ?? result.service.pid ?? "?"})\n`,
    );
  } else {
    const reason = daemonDegradedReason(snapshot);
    process.stderr.write(
      `[prim] ✗ launchd daemon did not reach healthy heartbeat + ingestion state${reason ? ` · ${reason}` : ""} (see ${LOG_PATH})\n`,
    );
    if (!process.exitCode) process.exitCode = EXIT_NOT_RUNNING;
  }
  console.log(
    JSON.stringify(
      {
        started: healthy,
        supervised: true,
        action: result.action,
        pid: snapshot?.pid ?? result.service.pid,
        loaded: result.service.loaded,
        responding: result.responding,
        healthy,
        ...daemonStartHealthFields(healthy, snapshot),
        version: snapshot?.version,
        expectedVersion,
      },
      null,
      2,
    ),
  );
}

async function daemonStart(opts: { foreground?: boolean }): Promise<void> {
  if (process.platform === "darwin") {
    if (!opts.foreground) {
      await macDaemonStart(false);
      return;
    }
  }
  await withDaemonLifecycleLock(async () => {
    setDaemonExplicitlyDisabled(false);
    await detachedDaemonStart(opts);
  });
}

async function daemonStop(): Promise<void> {
  if (process.platform !== "darwin") {
    await withDaemonLifecycleLock(async () => {
      setDaemonExplicitlyDisabled(true);
      await detachedDaemonStop();
    });
    return;
  }
  const result = await bootoutMacDaemon();
  process.stderr.write(
    result.wasLoaded
      ? "[prim] daemon stopped and explicitly disabled\n"
      : result.legacyStopped
        ? "[prim] legacy daemon stopped and explicitly disabled\n"
        : "[prim] daemon was not loaded; explicitly disabled\n",
  );
  console.log(
    JSON.stringify(
      {
        stopped: result.wasLoaded || result.legacyStopped,
        wasRunning: result.wasLoaded || result.legacyStopped,
        supervised: true,
        disabled: true,
      },
      null,
      2,
    ),
  );
}

export type DaemonStatusVerdict = {
  json: Record<string, unknown>;
  exitCode: number;
};

/**
 * Map daemon liveness onto the reported JSON + process exit code. Pure, so the
 * exit-code contract is unit-tested independently of sockets:
 *   - hard down (no live pid)         -> EXIT_NOT_RUNNING (2)
 *   - pid alive, socket not answering -> EXIT_BOOTING (3), state "starting"
 *   - live                            -> EXIT_OK (0)
 * Splitting "booting" from "down" stops a daemon that's still coming up from
 * reading as a hard failure — the exact misread that made a healthy restart
 * look broken when a status check was chained immediately after it.
 */
export function classifyStatus(
  pidAlive: boolean,
  responding: boolean,
  snapshot: StatusSnapshot | null,
  pid?: number,
): DaemonStatusVerdict {
  if (!pidAlive) {
    return { json: { running: false }, exitCode: EXIT_NOT_RUNNING };
  }
  if (!responding) {
    return {
      json: { running: true, responding: false, state: "starting", pid },
      exitCode: EXIT_BOOTING,
    };
  }
  if (!snapshot) {
    return { json: { running: true, responding: true }, exitCode: EXIT_OK };
  }
  if (snapshot.healthy === false) {
    return {
      json: { running: true, responding: true, state: "degraded", ...snapshot },
      exitCode: EXIT_BOOTING,
    };
  }
  return { json: { running: true, responding: true, ...snapshot }, exitCode: EXIT_OK };
}

export function classifyLaunchdStatus(
  service: LaunchdService,
  responding: boolean,
  snapshot: StatusSnapshot | null,
  disabled: boolean,
): DaemonStatusVerdict {
  if (!service.loaded) {
    if (responding) {
      return {
        json: {
          running: true,
          responding: true,
          supervised: false,
          state: "unsupervised",
          disabled,
          ...snapshot,
        },
        exitCode: EXIT_BOOTING,
      };
    }
    return {
      json: { running: false, supervised: true, loaded: false, disabled },
      exitCode: EXIT_NOT_RUNNING,
    };
  }
  if (!responding) {
    return {
      json: {
        running: true,
        responding: false,
        supervised: true,
        state: service.state ?? "starting",
        pid: service.pid,
        disabled,
      },
      exitCode: EXIT_BOOTING,
    };
  }
  if (!snapshot || service.pid === undefined) {
    return {
      json: {
        running: true,
        responding: true,
        supervised: true,
        state: "ownership_unverified",
        pid: service.pid,
        socketPid: snapshot?.pid,
        disabled,
      },
      exitCode: EXIT_BOOTING,
    };
  }
  if (service.pid !== snapshot.pid) {
    return {
      json: {
        running: true,
        responding: true,
        supervised: true,
        state: "pid_mismatch",
        pid: service.pid,
        socketPid: snapshot.pid,
        disabled,
      },
      exitCode: EXIT_BOOTING,
    };
  }
  if (snapshot?.healthy === false) {
    return {
      json: {
        running: true,
        responding: true,
        supervised: true,
        state: "degraded",
        disabled,
        ...snapshot,
      },
      exitCode: EXIT_BOOTING,
    };
  }
  return {
    json: {
      running: true,
      responding: true,
      supervised: true,
      state: service.state ?? "running",
      disabled,
      ...snapshot,
    },
    exitCode: EXIT_OK,
  };
}

function writeLiveSnapshot(snapshot: StatusSnapshot | null, supervised = false): void {
  if (!snapshot) {
    process.stderr.write(
      supervised ? "[prim] ✓ daemon live under launchd (no snapshot)\n" : "[prim] ✓ daemon live\n",
    );
    return;
  }
  const team =
    snapshot.onlineNames !== undefined
      ? ` · team: ${formatTeammates(snapshot.onlineNames, Number.POSITIVE_INFINITY)}`
      : "";
  if (snapshot.healthy === false) {
    const reason = daemonDegradedReason(snapshot);
    process.stderr.write(
      `[prim] ✗ daemon unhealthy${supervised ? " under launchd" : ""} · pid=${snapshot.pid}${team}${reason ? ` · ${reason}` : ""}\n`,
    );
    return;
  }
  process.stderr.write(
    `[prim] ✓ daemon live${supervised ? " under launchd" : ""} · pid=${snapshot.pid} · uptime=${Math.round(
      snapshot.uptimeMs / 1000,
    )}s · session=${snapshot.sessionId}${team}\n`,
  );
}

async function detachedDaemonStatus(): Promise<void> {
  const pid = readPidfile();
  const pidAlive = pid?.alive ?? false;
  const responding = pidAlive ? await daemonIsLive(STATUS_PROBE_TIMEOUT_MS) : false;
  const snapshot = responding
    ? await daemonRequest<StatusSnapshot>(
        "status_snapshot",
        {},
        { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
      )
    : null;

  const { json, exitCode } = classifyStatus(pidAlive, responding, snapshot, pid?.pid);

  if (!pidAlive) {
    process.stderr.write("[prim] ✗ daemon down\n");
  } else if (!responding) {
    process.stderr.write(`[prim] ◌ daemon pid=${pid?.pid} starting (socket not responding yet)\n`);
  } else {
    writeLiveSnapshot(snapshot);
  }
  console.log(JSON.stringify(json, null, 2));
  if (exitCode !== EXIT_OK && !process.exitCode) {
    process.exitCode = exitCode;
  }
}

async function macDaemonStatus(): Promise<void> {
  const service = getLaunchdService();
  const responding = await daemonIsLive(STATUS_PROBE_TIMEOUT_MS);
  const snapshot = responding
    ? await daemonRequest<StatusSnapshot>(
        "status_snapshot",
        {},
        { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
      )
    : null;
  const disabled = daemonExplicitlyDisabled();
  const { json, exitCode } = classifyLaunchdStatus(service, responding, snapshot, disabled);

  if (!service.loaded && responding) {
    process.stderr.write(
      `[prim] ◌ daemon pid=${snapshot?.pid ?? "?"} is live but not supervised by launchd\n`,
    );
  } else if (!service.loaded) {
    process.stderr.write(`[prim] ✗ daemon down${disabled ? " (explicitly disabled)" : ""}\n`);
  } else if (!responding) {
    process.stderr.write(
      `[prim] ◌ launchd service ${service.state ?? "loaded"}; socket is not responding yet\n`,
    );
  } else if (!snapshot || service.pid === undefined) {
    process.stderr.write("[prim] ✗ launchd daemon socket ownership could not be verified\n");
  } else if (service.pid !== snapshot.pid) {
    process.stderr.write(
      `[prim] ✗ launchd pid=${service.pid} does not own the daemon socket (pid=${snapshot.pid})\n`,
    );
  } else {
    writeLiveSnapshot(snapshot, true);
  }
  console.log(JSON.stringify(json, null, 2));
  if (exitCode !== EXIT_OK && !process.exitCode) process.exitCode = exitCode;
}

async function daemonStatus(): Promise<void> {
  if (process.platform === "darwin") {
    await macDaemonStatus();
    return;
  }
  await detachedDaemonStatus();
}

async function daemonRestart(opts: { foreground?: boolean }): Promise<void> {
  if (process.platform === "darwin" && !opts.foreground) {
    await macDaemonStart(true);
    return;
  }
  if (process.platform !== "darwin") {
    await withDaemonLifecycleLock(async () => {
      setDaemonExplicitlyDisabled(false);
      await detachedDaemonStop();
      await detachedDaemonStart(opts);
    });
    return;
  }
  await daemonStop();
  await daemonStart(opts);
}

async function daemonEnsure(): Promise<void> {
  if (process.platform !== "darwin") {
    const disabled = await withDaemonLifecycleLock(async () => {
      if (daemonExplicitlyDisabled()) return true;
      await detachedDaemonStart({});
      return false;
    });
    if (disabled) {
      process.stderr.write("[prim] daemon remains explicitly disabled\n");
      console.log(JSON.stringify({ ensured: false, disabled: true, supervised: false }, null, 2));
    }
    return;
  }
  const result = await ensureMacDaemon();
  if (result.state === "disabled") {
    process.stderr.write("[prim] daemon remains explicitly disabled\n");
  } else if (result.state === "running") {
    process.stderr.write(`[prim] ✓ daemon ensured under launchd (${result.action})\n`);
  } else {
    process.stderr.write(`[prim] ✗ daemon ensure failed; see ${LOG_PATH}\n`);
    if (!process.exitCode) process.exitCode = EXIT_NOT_RUNNING;
  }
  console.log(
    JSON.stringify(
      {
        ensured: result.state === "running",
        disabled: result.state === "disabled",
        supervised: true,
        action: result.action,
      },
      null,
      2,
    ),
  );
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Manage the prim companion daemon (latency unlock + presence + broadcast)");

  daemon
    .command("start")
    .description("Start the daemon (installs a supervised LaunchAgent on macOS)")
    .option("--foreground", "Run in the foreground (inherit stdio); use under launchd / systemd")
    .action(async (opts: { foreground?: boolean }) => {
      await daemonStart(opts);
    });

  daemon
    .command("stop")
    .description("Stop and explicitly disable the daemon")
    .action(async () => {
      await daemonStop();
    });

  daemon
    .command("status")
    .description("Report daemon liveness + a snapshot if responding")
    .action(async () => {
      await daemonStatus();
    });

  daemon
    .command("restart")
    .description("Restart the daemon and clear any explicit disable marker")
    .option("--foreground", "Restart in the foreground")
    .action(async (opts: { foreground?: boolean }) => {
      await daemonRestart(opts);
    });

  daemon
    .command("ensure")
    .description("Idempotently install, upgrade, and heal the daemon unless explicitly disabled")
    .action(async () => {
      await daemonEnsure();
    });
}
