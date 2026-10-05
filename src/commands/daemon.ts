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
import { join } from "node:path";
import { type Command, Option } from "commander";
import { daemonIsLive, daemonRequest } from "../daemon/client.js";
import type { DaemonHeartbeatHealth, DaemonIngestionHealth } from "../daemon/health.js";
import {
  type CurrentDaemonEnsureResult,
  runLatestDaemonBootstrap,
} from "../daemon/latest-bootstrap.js";
import {
  type LaunchdService,
  bootoutMacDaemon,
  daemonExplicitlyDisabled,
  ensureMacDaemon,
  getLaunchdService,
  setDaemonExplicitlyDisabled,
  withDaemonLifecycleLock,
} from "../daemon/launchd.js";
import { decisionIngestionStatus, repositoryBindingState } from "../lib/activation.js";
import { boundedHealthError } from "../lib/ansi.js";
import { binFile } from "../lib/bin-path.js";
import { deliveryBacklogState, deliveryBacklogSummary } from "../lib/delivery-backlog.js";
import { primConfigDirectory } from "../lib/paths.js";
import { type Teammate, formatTeammates } from "../lib/presence.js";
import { processIsAlive } from "../lib/process-liveness.js";
import {
  type RepositoryBindingDiagnosticState,
  repositoryBindingDiagnosticLabel,
} from "../lib/statusline-render.js";

const DAEMON_BIN = "prim-daemon-server";
const CONFIG_DIR = primConfigDirectory();
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
const READY_SNAPSHOT_TIMEOUT_MS = 30_000;
const READY_SNAPSHOT_POLL_MS = 250;
const EXIT_OK = 0;
const EXIT_NOT_RUNNING = 2;
// Pidfile alive but the socket isn't answering yet — booting (or wedged),
// distinct from hard-down so an agent can retry rather than treat it as failed.
const EXIT_BOOTING = 3;

type DecisionIngestionStatus = ReturnType<typeof decisionIngestionStatus>;

const VERIFIED_PREFIX = "[prim] ✓ ";

/**
 * Append Decision ingestion and, for a daemon behind its delivery SLA, the
 * shared backlog clause. A ready daemon whose delivery is failing, or that
 * holds organization buckets back, still started (start does not gate on
 * delivery), but its line must not read as all-clear, so its verdict becomes
 * a warning.
 */
export function formatDaemonLifecycleMessage(
  message: string,
  decisionIngestion: DecisionIngestionStatus,
  snapshot?: Pick<StatusSnapshot, "ingestion"> | null,
  now: number = Date.now(),
): string {
  const backlog = deliveryBacklogSummary(snapshot?.ingestion, now);
  const state = deliveryBacklogState(snapshot?.ingestion);
  const verdict =
    (state === "failing" || state === "retained") && message.startsWith(VERIFIED_PREFIX)
      ? `[prim] ⚠ ${message.slice(VERIFIED_PREFIX.length)}`
      : message;
  return `${verdict} · Decision ingestion ${decisionIngestion}${backlog ? ` · ${backlog}` : ""}`;
}

function formatCurrentDaemonLifecycleMessage(
  message: string,
  snapshot?: Pick<StatusSnapshot, "ingestion"> | null,
): string {
  return formatDaemonLifecycleMessage(message, decisionIngestionStatus(process.cwd()), snapshot);
}

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
  launchRevision?: string;
  onlineCount?: number;
  // Online teammates (self excluded), sorted. Surfaced in full here, where
  // there's room; the statusline truncates the same list.
  onlineNames?: string[];
  onlineTeammates?: Teammate[];
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

function requestStatusSnapshot(): Promise<StatusSnapshot | null> {
  return daemonRequest<StatusSnapshot>(
    "status_snapshot",
    {},
    { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
  );
}

export interface ReadySnapshotOptions {
  requestSnapshot?: () => Promise<StatusSnapshot | null>;
  sleep?: (ms: number) => Promise<void>;
  nowMs?: () => number;
}

/**
 * Poll until the expected-version daemon is start-ready (see
 * daemonStartIsReady) or the deadline elapses; returns the last snapshot so a
 * failure can name its cause. needsReauth is polled rather than returned
 * early: setup logs in immediately before `daemon start`, which finds an
 * already running expected-version daemon and does not restart it. That
 * daemon leaves its re-auth hold while serving one of these status reads and
 * heartbeats at once, so the window only has to cover that first heartbeat.
 */
export async function waitForReadySnapshot(
  expectedVersion: string,
  options: ReadySnapshotOptions = {},
): Promise<StatusSnapshot | null> {
  const request = options.requestSnapshot ?? requestStatusSnapshot;
  const wait = options.sleep ?? sleep;
  const nowMs = options.nowMs ?? Date.now;
  const deadline = nowMs() + READY_SNAPSHOT_TIMEOUT_MS;
  let snapshot: StatusSnapshot | null = null;
  while (nowMs() < deadline) {
    snapshot = await request();
    if (daemonStartIsReady(true, snapshot, expectedVersion)) return snapshot;
    await wait(READY_SNAPSHOT_POLL_MS);
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

/**
 * Start/restart readiness: the supervised daemon on the expected version is
 * answering, its heartbeat has proven auth + connectivity, and auth has not
 * terminally ended. Ingestion is deliberately not part of readiness: its
 * health is false whenever any Move is older than the 30s SLA, so a machine
 * with a pre-existing backlog could not start until the very drain only a
 * started daemon performs had finished. On a clean install ingestion starts
 * healthy with nothing queued, so that gate never proved delivery anyway;
 * doctor's server checks cover reachability, auth, and capture entitlement.
 * Only the ingestion cause is exempted — any other unhealthy aggregate still
 * fails closed.
 */
export function daemonStartIsReady(
  serviceReady: boolean,
  snapshot: Pick<
    StatusSnapshot,
    "healthy" | "version" | "needsReauth" | "heartbeat" | "ingestion"
  > | null,
  expectedVersion: string | undefined,
): boolean {
  if (!serviceReady || !snapshot || expectedVersion === undefined) return false;
  if (snapshot.version !== expectedVersion || snapshot.needsReauth === true) return false;
  if (snapshot.healthy === true) return true;
  return snapshot.heartbeat?.healthy === true && snapshot.ingestion?.healthy === false;
}

/**
 * Additive JSON for a ready daemon behind its delivery SLA, one flag per
 * delivery state: `draining`, `deliveryRetained` while it holds organization
 * buckets back, or `deliveryFailing`. A daemon within its SLA adds nothing,
 * so healthy JSON stays byte-identical.
 */
function daemonBacklogFields(snapshot: StatusSnapshot | null): Record<string, unknown> {
  const state = deliveryBacklogState(snapshot?.ingestion);
  if (!state) return {};
  if (state === "draining") return { draining: true, ingestion: snapshot?.ingestion };
  return state === "retained"
    ? { draining: false, deliveryRetained: true, ingestion: snapshot?.ingestion }
    : { draining: false, deliveryFailing: true, ingestion: snapshot?.ingestion };
}

export function daemonStartHealthFields(
  ready: boolean,
  snapshot: StatusSnapshot | null,
): Record<string, unknown> {
  if (ready) return daemonBacklogFields(snapshot);
  return {
    state: "degraded",
    needsReauth: snapshot?.needsReauth === true,
    heartbeat: snapshot?.heartbeat ?? null,
    ingestion: snapshot?.ingestion ?? null,
  };
}

/**
 * Name why start did not become ready. A version skew is checked before the
 * degraded reason because that reason would otherwise blame an ingestion
 * backlog, which no longer gates start.
 */
export function daemonStartFailureReason(
  snapshot: StatusSnapshot | null,
  expectedVersion: string | undefined,
): string | undefined {
  if (
    snapshot &&
    !snapshot.needsReauth &&
    expectedVersion !== undefined &&
    snapshot.version !== expectedVersion
  ) {
    return `daemon reports ${snapshot.version ? `v${snapshot.version}` : "no version"}, expected v${expectedVersion}`;
  }
  return daemonDegradedReason(snapshot);
}

async function detachedDaemonStart(opts: { foreground?: boolean }): Promise<void> {
  const existing = readPidfile();
  if (existing?.alive) {
    const snapshot = await verifiedPid(existing);
    if (snapshot) {
      process.stderr.write(
        `${formatCurrentDaemonLifecycleMessage(`[prim] daemon already running (pid=${existing.pid})`, snapshot)}\n`,
      );
      console.log(
        JSON.stringify(
          { started: false, pid: existing.pid, ...daemonBacklogFields(snapshot) },
          null,
          2,
        ),
      );
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

  // Hand the detached child an append fd to the resolved daemon log for
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
    // Readiness here is the socket alone; one best-effort snapshot only lets
    // the line report a backlog that is draining, held back, or failing.
    const snapshot = await requestStatusSnapshot();
    process.stderr.write(
      `${formatCurrentDaemonLifecycleMessage(`[prim] ✓ daemon started (pid=${after?.pid ?? "?"}, socket=${SOCK_PATH})`, snapshot)}\n`,
    );
    console.log(
      JSON.stringify({ started: true, pid: after?.pid, ...daemonBacklogFields(snapshot) }, null, 2),
    );
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
    const socketOwner = await daemonRequest<StatusSnapshot>(
      "status_snapshot",
      {},
      { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
    );
    if (existsSync(PID_PATH) || existsSync(SOCK_PATH) || socketOwner) {
      process.stderr.write(
        `[prim] refusing to verify daemon absence: ${
          socketOwner ? `socket is owned by pid=${socketOwner.pid}` : "daemon artifacts remain"
        }\n`,
      );
      console.log(
        JSON.stringify(
          {
            stopped: false,
            wasRunning: true,
            ...(socketOwner ? { pid: socketOwner.pid } : {}),
            verified: false,
          },
          null,
          2,
        ),
      );
      if (!process.exitCode) process.exitCode = EXIT_BOOTING;
      return;
    }
    process.stderr.write("[prim] daemon not running (verified absent)\n");
    console.log(
      JSON.stringify({ stopped: false, wasRunning: false, absent: true, verified: true }, null, 2),
    );
    return;
  }
  if (!existing.alive) {
    const socketOwner = await daemonRequest<StatusSnapshot>(
      "status_snapshot",
      {},
      { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
    );
    if (socketOwner || existsSync(SOCK_PATH)) {
      process.stderr.write(
        `[prim] refusing to clear stale pidfile: ${
          socketOwner ? `socket is owned by pid=${socketOwner.pid}` : "socket artifact remains"
        }\n`,
      );
      console.log(
        JSON.stringify(
          { stopped: false, pid: socketOwner?.pid ?? existing.pid, verified: false },
          null,
          2,
        ),
      );
      if (!process.exitCode) process.exitCode = EXIT_BOOTING;
      return;
    }
    clearStaleArtifacts();
    process.stderr.write("[prim] daemon not running (cleared stale pidfile)\n");
    console.log(
      JSON.stringify({ stopped: false, wasRunning: false, absent: true, verified: true }, null, 2),
    );
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
    console.log(JSON.stringify({ stopped: false, pid: existing.pid, verified: false }, null, 2));
    if (!process.exitCode) process.exitCode = EXIT_BOOTING;
    return;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(existing.pid)) {
      clearStaleArtifacts();
      process.stderr.write(`[prim] daemon stopped (pid=${existing.pid})\n`);
      console.log(
        JSON.stringify(
          { stopped: true, wasRunning: true, pid: existing.pid, absent: true, verified: true },
          null,
          2,
        ),
      );
      return;
    }
    await sleep(STOP_POLL_MS);
  }
  process.stderr.write(
    `[prim] daemon did not exit within ${STOP_TIMEOUT_MS}ms (pid=${existing.pid} still alive)\n`,
  );
  console.log(JSON.stringify({ stopped: false, pid: existing.pid, verified: false }, null, 2));
  if (!process.exitCode) process.exitCode = EXIT_BOOTING;
}

async function macDaemonStart(forceRestart = false): Promise<void> {
  const result = await ensureMacDaemon({ explicitlyStarted: true, forceRestart });
  const serviceReady = result.state === "running";
  const expectedVersion = result.runtime?.manifest.version;
  const snapshot =
    serviceReady && expectedVersion ? await waitForReadySnapshot(expectedVersion) : null;
  const ready = daemonStartIsReady(serviceReady, snapshot, expectedVersion);
  if (ready) {
    const verb = result.action === "none" ? "already running" : "started";
    const servicePid = result.service.loaded ? result.service.pid : undefined;
    process.stderr.write(
      `${formatCurrentDaemonLifecycleMessage(`[prim] ✓ daemon ${verb} under launchd (pid=${snapshot?.pid ?? servicePid ?? "?"})`, snapshot)}\n`,
    );
  } else if (!(serviceReady && expectedVersion)) {
    // No snapshot was polled: launchd itself never ran the desired daemon.
    process.stderr.write(
      `[prim] ✗ launchd did not converge on the desired daemon (${result.action}) (see ${LOG_PATH})\n`,
    );
    if (!process.exitCode) process.exitCode = EXIT_NOT_RUNNING;
  } else {
    const reason = daemonStartFailureReason(snapshot, expectedVersion);
    process.stderr.write(
      `[prim] ✗ launchd daemon did not reach a healthy heartbeat on the expected version${reason ? ` · ${reason}` : ""} (see ${LOG_PATH})\n`,
    );
    if (!process.exitCode) process.exitCode = EXIT_NOT_RUNNING;
  }
  console.log(
    JSON.stringify(
      {
        started: ready,
        supervised: true,
        action: result.action,
        pid: snapshot?.pid ?? (result.service.loaded ? result.service.pid : undefined),
        loaded: result.service.loaded,
        responding: result.responding,
        // `healthy` keeps meaning "start succeeded" (always equal to `started`
        // and the exit code) so existing consumers stay correct. It is not the
        // daemon's own health: `daemon status --json` stays degraded while a
        // backlog drains, is held back, or fails to deliver, which start
        // reports additively via `draining`, `deliveryRetained`,
        // `deliveryFailing`, and `ingestion`.
        healthy: ready,
        ...daemonStartHealthFields(ready, snapshot),
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
        absent: true,
        verified: true,
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
  service: LaunchdService | undefined,
  responding: boolean,
  snapshot: StatusSnapshot | null,
  disabled: boolean,
): DaemonStatusVerdict {
  if (!service) {
    return {
      json: {
        running: responding,
        responding,
        supervised: true,
        state: "unknown",
        disabled,
        ...(snapshot ?? {}),
      },
      exitCode: EXIT_BOOTING,
    };
  }
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

export function formatDaemonSnapshotMessage(
  snapshot: StatusSnapshot | null,
  supervised: boolean,
  decisionIngestion: DecisionIngestionStatus,
  bindingState?: RepositoryBindingDiagnosticState,
): string {
  const bindingLabel = snapshot?.needsReauth
    ? undefined
    : repositoryBindingDiagnosticLabel(bindingState);
  const bindingSuffix = bindingLabel ? ` · ${bindingLabel}` : "";
  if (!snapshot) {
    return supervised
      ? `[prim] ✓ daemon live, Decision ingestion ${decisionIngestion} under launchd (no snapshot)${bindingSuffix}`
      : `[prim] ✓ daemon live, Decision ingestion ${decisionIngestion}${bindingSuffix}`;
  }
  const team =
    snapshot.onlineNames !== undefined
      ? ` · team: ${formatTeammates(snapshot.onlineNames, Number.POSITIVE_INFINITY)}`
      : "";
  if (snapshot.healthy === false) {
    const reason = daemonDegradedReason(snapshot);
    return `[prim] ✗ daemon unhealthy${supervised ? " under launchd" : ""} · pid=${snapshot.pid}${team}${reason ? ` · ${reason}` : ""}`;
  }
  return `[prim] ✓ daemon live, Decision ingestion ${decisionIngestion}${supervised ? " under launchd" : ""}${bindingSuffix} · pid=${snapshot.pid} · uptime=${Math.round(
    snapshot.uptimeMs / 1000,
  )}s · session=${snapshot.sessionId}${team}`;
}

function localRepositoryBindingDiagnostic(
  decisionIngestion: DecisionIngestionStatus,
): RepositoryBindingDiagnosticState | undefined {
  if (decisionIngestion !== "enabled") return undefined;
  const state = repositoryBindingState(process.cwd());
  return state === "unbound" || state === "invalid" ? state : undefined;
}

function writeLiveSnapshot(snapshot: StatusSnapshot | null, supervised = false): void {
  const decisionIngestion =
    snapshot?.healthy === false ? "disabled" : decisionIngestionStatus(process.cwd());
  const bindingState = localRepositoryBindingDiagnostic(decisionIngestion);
  process.stderr.write(
    `${formatDaemonSnapshotMessage(snapshot, supervised, decisionIngestion, bindingState)}\n`,
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
  let service: LaunchdService | undefined;
  let launchdError: unknown;
  try {
    service = getLaunchdService();
  } catch (error) {
    launchdError = error;
  }
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

  if (!service) {
    const detail = boundedHealthError(
      launchdError instanceof Error ? launchdError.message : String(launchdError),
    );
    process.stderr.write(`[prim] ✗ launchd status unavailable${detail ? `: ${detail}` : ""}\n`);
  } else if (!service.loaded && responding) {
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

async function daemonEnsure(): Promise<CurrentDaemonEnsureResult> {
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
    return { disabled };
  }
  const result = await ensureMacDaemon();
  // Ensure never gated on health; one best-effort snapshot only lets the line
  // report a backlog that is draining, held back, or failing.
  const snapshot = result.state === "running" ? await requestStatusSnapshot() : null;
  if (result.state === "disabled") {
    process.stderr.write("[prim] daemon remains explicitly disabled\n");
  } else if (result.state === "running") {
    process.stderr.write(
      `${formatCurrentDaemonLifecycleMessage(`[prim] ✓ daemon ensured under launchd (${result.action})`, snapshot)}\n`,
    );
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
        ...daemonBacklogFields(snapshot),
      },
      null,
      2,
    ),
  );
  return { disabled: result.state === "disabled" };
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
    .addOption(new Option("--latest-bootstrap").hideHelp())
    .action(async (opts: { latestBootstrap?: boolean }) => {
      if (opts.latestBootstrap) {
        await runLatestDaemonBootstrap(daemonEnsure);
        return;
      }
      await daemonEnsure();
    });
}
