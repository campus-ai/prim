#!/usr/bin/env node
/**
 * `prim-daemon-server` — long-lived per-user companion for the prim hooks.
 *
 * Opens a Unix socket at ~/.config/prim/sock that the PreToolUse /
 * SessionStart / SessionEnd hooks proxy through; amortizes the token-refresh
 * check; and heartbeats `agentPresence` every 30s, caching the online count
 * and the teammate-name roster the ack returns so a statusline can render
 * "team: Maya, Alex +2" (and `daemon status` the full list).
 *
 * Lifecycle: `prim daemon start` spawns this bin detached. SIGTERM (or
 * `prim daemon stop`) cleans up the socket + pidfile. Refuses to start if an
 * existing pid is still alive.
 *
 * Fail-soft: every hook also retains its direct HTTP path. If the daemon is
 * down, hooks degrade to ~200ms instead of ~30ms; never to an outright block.
 */

import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getClient, getSiteUrl, getTokenExpiresAt, refreshToken } from "../client.js";
import { FlushError, flush } from "../flusher.js";
import { pendingJournalStats } from "../journal.js";
import type { Teammate } from "../lib/presence.js";
import { daemonRequest } from "./client.js";
import { assertCallerEnvMatches, isCrossEnv } from "./env-binding.js";
import {
  createDaemonHealthState,
  heartbeatRetryDelayMs,
  ingestionRetryDelayMs,
  refreshDaemonHealth,
  writeDaemonHealthState,
} from "./health.js";
import {
  DAEMON_STARTUP_GRACE_MS,
  type DaemonOwnership,
  acquireDaemonOwnership,
  daemonProcessIsAlive,
  readDaemonOwner,
  readDaemonPid,
  releaseDaemonOwnership,
} from "./instance-lock.js";

const CONFIG_DIR = join(homedir(), ".config", "prim");
const SOCK_PATH = join(CONFIG_DIR, "sock");

const HEARTBEAT_INTERVAL_MS = 30_000;
const INGESTION_POLL_INTERVAL_MS = 15_000;
const TOKEN_CHECK_INTERVAL_MS = 60_000;
const TOKEN_REFRESH_THRESHOLD_MS = 90_000;
const HTTP_PROXY_TIMEOUT_MS = 10_000;
// How long cached presence (count + names) stays trustworthy after the last
// accepted heartbeat (≈ 3 heartbeat cadences). Past this, the daemon is alive
// but its heartbeats are failing, so the frozen data is reported as stale.
const PRESENCE_FRESH_WINDOW_MS = 90_000;
const EXIT_OK = 0;
const EXIT_CRASH = 1;

interface SocketRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface SocketResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const startedAt = Date.now();
const client = getClient();
const runtimeVersion = resolveRuntimeVersion();
const daemonHealth = createDaemonHealthState(runtimeVersion, process.pid, startedAt);
let activeSessionId = process.env.PRIM_DAEMON_SESSION_ID ?? `daemon-${process.pid}`;
let lastHeartbeatAt: number | undefined;
// From the last accepted heartbeat ack, cached for the statusline /
// daemon-status to render. The server owns identity + display names (derived
// from the token); the daemon never asserts them, it only relays what the ack
// carried — `onlineCount` is the self-inclusive same-org count, `onlineNames`
// the caller's online teammates (self excluded), already deduped and sorted.
let lastOnlineCount: number | undefined;
let lastOnlineNames: string[] | undefined;
let lastOnlineTeammates: Teammate[] | undefined;
// Daemon-local timestamp of the last ACCEPTED heartbeat ack. Used to decide
// whether the cached presence (count + names) is still fresh; a daemon whose
// heartbeats are failing keeps running but stops advancing this.
let lastOkAtLocal: number | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let ingestionTimer: NodeJS.Timeout | undefined;
let tokenCheckTimer: NodeJS.Timeout | undefined;
let heartbeatInFlight: Promise<void> | undefined;
let heartbeatRerunRequested = false;
let ownership: DaemonOwnership | undefined;
let socketServer: Server | undefined;
let shuttingDown = false;

function resolveRuntimeVersion(): string {
  if (process.env.PRIM_RUNTIME_VERSION) {
    return process.env.PRIM_RUNTIME_VERSION;
  }
  try {
    const here = fileURLToPath(new URL(".", import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function persistHealth(): void {
  refreshDaemonHealth(daemonHealth, Date.now());
  daemonHealth.updatedAt = Date.now();
  try {
    writeDaemonHealthState(daemonHealth);
  } catch (err) {
    process.stderr.write(`[prim-daemon] health-state error: ${errorMessage(err)}\n`);
  }
}

function updatePendingHealth(): void {
  const pending = pendingJournalStats();
  daemonHealth.ingestion.pendingCount = pending.pendingCount;
  daemonHealth.ingestion.pendingSampled = pending.sampled;
  daemonHealth.ingestion.oldestPendingAt = pending.oldestPendingAt;
  daemonHealth.ingestion.strandedCount = pending.strandedCount;
}

async function takeOwnership(): Promise<void> {
  const now = Date.now();
  const recordedOwner = readDaemonOwner(CONFIG_DIR);
  const recordedPid = readDaemonPid(CONFIG_DIR);
  const candidatePids = new Set(
    [recordedOwner?.pid, recordedPid?.pid].filter(
      (pid): pid is number => pid !== undefined && daemonProcessIsAlive(pid),
    ),
  );

  // A positive socket handshake is authoritative, but a failed handshake is
  // not proof that a still-live lock owner has exited: it may only be wedged.
  // Never admit a second owner in that state. launchd's kickstart path owns
  // terminating the tracked process before a replacement can acquire the lock.
  if (existsSync(SOCK_PATH) || candidatePids.size > 0) {
    const snapshot = await daemonRequest<{ pid?: number }>(
      "status_snapshot",
      {},
      { timeoutMs: 500 },
    );
    if (typeof snapshot?.pid === "number") {
      throw new Error(`daemon already running (pid=${String(snapshot.pid)})`);
    }
  }
  const ownerIsStarting =
    recordedOwner !== undefined &&
    candidatePids.has(recordedOwner.pid) &&
    now - recordedOwner.startedAt < DAEMON_STARTUP_GRACE_MS;
  const legacyIsStarting =
    recordedPid !== undefined &&
    candidatePids.has(recordedPid.pid) &&
    now - recordedPid.mtimeMs < DAEMON_STARTUP_GRACE_MS;
  if (ownerIsStarting || legacyIsStarting) {
    throw new Error("daemon startup already in progress");
  }
  if (recordedOwner !== undefined && candidatePids.has(recordedOwner.pid)) {
    throw new Error(
      `daemon ownership held by live pid=${String(recordedOwner.pid)} (socket unavailable)`,
    );
  }
  if (recordedPid !== undefined && candidatePids.has(recordedPid.pid)) {
    throw new Error(
      `legacy daemon pid=${String(recordedPid.pid)} is still alive (socket unavailable)`,
    );
  }

  ownership = acquireDaemonOwnership(CONFIG_DIR);
  // With the exclusive instance lock held and no live legacy owner, any
  // remaining socket is a crash artifact. A second live daemon never reaches
  // this point and therefore cannot unlink the winner's socket.
  try {
    unlinkSync(SOCK_PATH);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      throw err;
    }
  }
}

function cleanup(): void {
  if (ownership) {
    try {
      releaseDaemonOwnership(ownership, SOCK_PATH);
    } catch (err) {
      process.stderr.write(`[prim-daemon] cleanup error: ${errorMessage(err)}\n`);
    }
  }
}

async function performHeartbeat(): Promise<void> {
  daemonHealth.heartbeat.lastAttemptAt = Date.now();
  persistHealth();
  try {
    // The body is `{ sessionId }` ONLY — the server derives identity and the
    // display names from the authenticated token. The ack carries the online
    // count and the teammate names, which we cache for the statusline and
    // daemon status.
    const result = (await client.post(
      "/api/cli/presence/heartbeat",
      { sessionId: activeSessionId },
      { signal: AbortSignal.timeout(HTTP_PROXY_TIMEOUT_MS) },
    )) as {
      accepted?: boolean;
      lastHeartbeatAt?: number;
      created?: boolean;
      onlineCount?: number;
      onlineNames?: string[];
      onlineTeammates?: Teammate[];
      unavailable?: string;
    };
    if (result.accepted) {
      const now = Date.now();
      lastOkAtLocal = now;
      daemonHealth.heartbeat.lastSuccessAt = now;
      daemonHealth.heartbeat.lastError = undefined;
      daemonHealth.heartbeat.consecutiveFailures = 0;
      if (typeof result.lastHeartbeatAt === "number") {
        lastHeartbeatAt = result.lastHeartbeatAt;
      }
      // Count, names, and teammates(+area) ride the SAME ack — cache them
      // atomically (clearing on absence), never overwrite-only. Otherwise a
      // partial ack from an older or rolled-back server (mixed-version deploy)
      // advances the freshness clock while a prior roster stays frozen, and the
      // statusline would render that stale list as fresh instead of falling
      // back down the ladder (teammates → names → count).
      lastOnlineCount = typeof result.onlineCount === "number" ? result.onlineCount : undefined;
      lastOnlineNames = Array.isArray(result.onlineNames) ? result.onlineNames : undefined;
      lastOnlineTeammates = Array.isArray(result.onlineTeammates)
        ? result.onlineTeammates
        : undefined;
    } else {
      daemonHealth.heartbeat.lastRejectedAt = Date.now();
      daemonHealth.heartbeat.lastError =
        typeof result.unavailable === "string" ? result.unavailable : "heartbeat rejected";
      daemonHealth.heartbeat.consecutiveFailures += 1;
    }
    persistHealth();
  } catch (err) {
    daemonHealth.heartbeat.lastError = errorMessage(err);
    daemonHealth.heartbeat.consecutiveFailures += 1;
    persistHealth();
    process.stderr.write(`[prim-daemon] heartbeat error: ${errorMessage(err)}\n`);
  }
}

/** Collapse concurrent timer/session requests into one heartbeat, then rerun
 * once if the active session changed while that request was in flight. */
function sendHeartbeat(): Promise<void> {
  if (heartbeatInFlight) {
    heartbeatRerunRequested = true;
    return heartbeatInFlight;
  }
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  heartbeatInFlight = (async () => {
    do {
      heartbeatRerunRequested = false;
      await performHeartbeat();
    } while (heartbeatRerunRequested && !shuttingDown);
  })().finally(() => {
    heartbeatInFlight = undefined;
    scheduleHeartbeat();
  });
  return heartbeatInFlight;
}

function scheduleHeartbeat(): void {
  if (shuttingDown) {
    return;
  }
  const failures = daemonHealth.heartbeat.consecutiveFailures;
  const delay = failures > 0 ? heartbeatRetryDelayMs(failures) : HEARTBEAT_INTERVAL_MS;
  daemonHealth.heartbeat.nextRetryAt = failures > 0 ? Date.now() + delay : undefined;
  persistHealth();
  heartbeatTimer = setTimeout(() => {
    heartbeatTimer = undefined;
    void sendHeartbeat();
  }, delay);
}

async function ensureTokenFresh(): Promise<void> {
  const expiresAt = getTokenExpiresAt();
  if (!expiresAt) {
    return;
  }
  if (Date.now() >= expiresAt - TOKEN_REFRESH_THRESHOLD_MS) {
    try {
      await refreshToken({ signal: AbortSignal.timeout(HTTP_PROXY_TIMEOUT_MS) });
    } catch {
      // best-effort; the next hook call's reactive 401 path will retry
    }
  }
}

function scheduleIngestion(delayMs: number): void {
  if (shuttingDown) {
    return;
  }
  ingestionTimer = setTimeout(() => {
    ingestionTimer = undefined;
    void runIngestionLoop();
  }, delayMs);
}

async function runIngestionLoop(): Promise<void> {
  try {
    updatePendingHealth();
  } catch (err) {
    const failures = daemonHealth.ingestion.consecutiveFailures + 1;
    const delay = ingestionRetryDelayMs(failures);
    daemonHealth.ingestion.consecutiveFailures = failures;
    daemonHealth.ingestion.lastError = `journal scan failed: ${errorMessage(err)}`;
    daemonHealth.ingestion.nextRetryAt = Date.now() + delay;
    persistHealth();
    scheduleIngestion(delay);
    return;
  }

  if (daemonHealth.ingestion.pendingCount === 0 && !daemonHealth.ingestion.pendingSampled) {
    // Another bounded flusher may have completed a previously-failed queue.
    // Once nothing remains, the resolved failure should not poison health.
    daemonHealth.ingestion.consecutiveFailures = 0;
    daemonHealth.ingestion.lastError = undefined;
    daemonHealth.ingestion.nextRetryAt = undefined;
    persistHealth();
    scheduleIngestion(INGESTION_POLL_INTERVAL_MS);
    return;
  }

  daemonHealth.ingestion.lastAttemptAt = Date.now();
  daemonHealth.ingestion.nextRetryAt = undefined;
  persistHealth();
  try {
    const result = await flush();
    daemonHealth.ingestion.lastSuccessAt = Date.now();
    daemonHealth.ingestion.lastAcknowledgedCount = result.flushed;
    daemonHealth.ingestion.consecutiveFailures = 0;
    daemonHealth.ingestion.lastError = undefined;
    updatePendingHealth();
    persistHealth();
    scheduleIngestion(INGESTION_POLL_INTERVAL_MS);
  } catch (err) {
    const failures = daemonHealth.ingestion.consecutiveFailures + 1;
    const delay = ingestionRetryDelayMs(failures);
    daemonHealth.ingestion.lastAcknowledgedCount = err instanceof FlushError ? err.flushed : 0;
    daemonHealth.ingestion.consecutiveFailures = failures;
    daemonHealth.ingestion.lastError = errorMessage(err);
    daemonHealth.ingestion.nextRetryAt = Date.now() + delay;
    try {
      updatePendingHealth();
    } catch {
      // The delivery error is already recorded; retry will rescan.
    }
    persistHealth();
    process.stderr.write(`[prim-daemon] ingestion error: ${errorMessage(err)}\n`);
    scheduleIngestion(delay);
  }
}

async function handleConflictCheck(params: Record<string, unknown>): Promise<unknown> {
  assertCallerEnvMatches(params.callerEnv, getSiteUrl());
  if (typeof params.file !== "string") {
    throw new Error("conflict_check requires `file: string`");
  }
  // The body is `{ file }` ONLY — conflict-scoring policy (fan-out /
  // reversibility thresholds) is owned entirely by the server. The daemon is
  // a transparent proxy; it forwards the path and relays the verdict verbatim.
  return await client.post("/api/cli/decisions/conflict-check", { file: params.file });
}

function pathParam(params: Record<string, unknown>): string {
  if (typeof params.path !== "string" || !params.path.startsWith("/api/cli/")) {
    throw new Error("proxy request requires `path: string` under /api/cli/");
  }
  return params.path;
}

function assertEndpointPath(path: string, endpoint: string): void {
  if (path !== endpoint && !path.startsWith(`${endpoint}?`)) {
    throw new Error(`proxy path must be ${endpoint} or ${endpoint}?...`);
  }
}

async function proxyGet(params: Record<string, unknown>, allowedPrefix: string): Promise<unknown> {
  // getSiteUrl() fresh (not a boot snapshot) so the guard tracks the very URL
  // request() will hit — both re-resolve from the daemon's fixed env + cwd.
  assertCallerEnvMatches(params.callerEnv, getSiteUrl());
  const path = pathParam(params);
  assertEndpointPath(path, allowedPrefix);
  return await client.get(path, { signal: AbortSignal.timeout(HTTP_PROXY_TIMEOUT_MS) });
}

function handleStatusSnapshot(params: Record<string, unknown>): unknown {
  const wasHealthy = daemonHealth.healthy;
  const heartbeatWasHealthy = daemonHealth.heartbeat.healthy;
  const ingestionWasHealthy = daemonHealth.ingestion.healthy;
  refreshDaemonHealth(daemonHealth, Date.now());
  if (
    wasHealthy !== daemonHealth.healthy ||
    heartbeatWasHealthy !== daemonHealth.heartbeat.healthy ||
    ingestionWasHealthy !== daemonHealth.ingestion.healthy
  ) {
    persistHealth();
  }
  const base = {
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    sessionId: activeSessionId,
    lastHeartbeatAt,
    version: runtimeVersion,
    healthy: daemonHealth.healthy,
    heartbeat: { ...daemonHealth.heartbeat },
    ingestion: { ...daemonHealth.ingestion },
  };
  // Presence is this daemon's own bound-env heartbeat. A cross-env caller (e.g. a
  // prod statusline reading a staging-bound daemon) must not see that roster:
  // withhold count/names and flag the mismatch so the statusline shows
  // "presence: other env" instead of another deployment's team. There is no
  // direct fallback for presence, so unlike the proxied reads this withholds
  // rather than throws. `daemon status` sends no callerEnv and still sees it all.
  if (isCrossEnv(params.callerEnv, getSiteUrl())) {
    return {
      ...base,
      onlineCount: undefined,
      onlineNames: undefined,
      onlineTeammates: undefined,
      presenceStale: false,
      envMismatch: true,
    };
  }
  const presenceFresh =
    lastOkAtLocal !== undefined &&
    daemonHealth.heartbeat.consecutiveFailures === 0 &&
    Date.now() - lastOkAtLocal < PRESENCE_FRESH_WINDOW_MS;
  // Stale only once we HAD an accepted ack that has since aged out — a daemon
  // that simply hasn't acked yet is not stale, just countless ("team: —").
  const presenceStale = lastOkAtLocal !== undefined && !presenceFresh;
  return {
    ...base,
    // Withhold a frozen count/names/teammates once they're no longer fresh; the
    // statusline shows "presence: stale" rather than a confident, wrong list.
    onlineCount: presenceFresh ? lastOnlineCount : undefined,
    onlineNames: presenceFresh ? lastOnlineNames : undefined,
    onlineTeammates: presenceFresh ? lastOnlineTeammates : undefined,
    presenceStale,
  };
}

async function dispatchRequest(req: SocketRequest): Promise<SocketResponse> {
  const id = req.id;
  try {
    switch (req.method) {
      case "conflict_check": {
        const result = await handleConflictCheck(req.params ?? {});
        return { id, ok: true, result };
      }
      case "decisions_recent": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/recent");
        return { id, ok: true, result };
      }
      case "decisions_show": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/show");
        return { id, ok: true, result };
      }
      case "decisions_cascade": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/cascade");
        return { id, ok: true, result };
      }
      case "decisions_affecting": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/affecting");
        return { id, ok: true, result };
      }
      case "session_start": {
        const sid = req.params?.sessionId;
        if (typeof sid === "string" && sid.length > 0) {
          activeSessionId = sid;
        }
        await sendHeartbeat();
        return { id, ok: true, result: { sessionId: activeSessionId } };
      }
      case "session_end": {
        // Keep the daemon heartbeating under its synthesized session id;
        // per-session presence is a later refinement.
        return { id, ok: true, result: { ack: true } };
      }
      case "status_snapshot":
        return { id, ok: true, result: handleStatusSnapshot(req.params ?? {}) };
      case "ping":
        return { id, ok: true, result: { pong: true } };
      default:
        return { id, ok: false, error: `unknown method: ${req.method}` };
    }
  } catch (err) {
    return {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function handleConnection(conn: Socket): void {
  let buffer = "";
  conn.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        try {
          const req = JSON.parse(line) as SocketRequest;
          dispatchRequest(req).then(
            (res) => {
              conn.write(`${JSON.stringify(res)}\n`);
            },
            () => {
              // dispatcher should not throw; defensive only
            },
          );
        } catch {
          // ignore malformed envelopes — fail-soft
        }
      }
      newlineIdx = buffer.indexOf("\n");
    }
  });
  conn.on("error", () => {
    // socket clients come and go; never propagate
  });
}

function shutdown(exitCode: number, reason: string): void {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  process.stderr.write(`${reason}\n`);
  stopTimers();
  try {
    socketServer?.close();
  } catch {
    // The listener may not have bound yet.
  }
  cleanup();
  process.exit(exitCode);
}

function startSocketServer(): void {
  socketServer = createServer(handleConnection);
  socketServer.on("error", (err) => {
    // A bind/runtime socket failure means the daemon cannot serve hooks. Exit
    // non-zero so launchd restarts it; staying PID-alive/socket-dead is never a
    // valid degraded mode.
    shutdown(EXIT_CRASH, `[prim-daemon] fatal socket error: ${err.message}`);
  });
  socketServer.listen(SOCK_PATH, () => {
    process.stderr.write(`[prim-daemon] listening on ${SOCK_PATH}\n`);
    startTimers();
    process.stderr.write(
      `[prim-daemon] started (pid=${process.pid}, session=${activeSessionId}, version=${runtimeVersion})\n`,
    );
  });
}

function startTimers(): void {
  persistHealth();
  void sendHeartbeat();
  void runIngestionLoop();
  void runTokenCheckLoop();
}

async function runTokenCheckLoop(): Promise<void> {
  await ensureTokenFresh();
  if (!shuttingDown) {
    tokenCheckTimer = setTimeout(() => {
      tokenCheckTimer = undefined;
      void runTokenCheckLoop();
    }, TOKEN_CHECK_INTERVAL_MS);
  }
}

function stopTimers(): void {
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
  }
  if (ingestionTimer) {
    clearTimeout(ingestionTimer);
  }
  if (tokenCheckTimer) {
    clearTimeout(tokenCheckTimer);
  }
}

function installSignalHandlers(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      shutdown(EXIT_OK, `[prim-daemon] ${signal}, shutting down (pid=${process.pid})`);
    });
  }
  process.on("uncaughtException", (err) => {
    shutdown(EXIT_CRASH, `[prim-daemon] uncaught: ${err.message}`);
  });
  process.on("unhandledRejection", (err) => {
    shutdown(EXIT_CRASH, `[prim-daemon] unhandled rejection: ${errorMessage(err)}`);
  });
}

async function main(): Promise<void> {
  try {
    await takeOwnership();
  } catch (err) {
    process.stderr.write(`[prim-daemon] ${errorMessage(err)}\n`);
    cleanup();
    process.exit(EXIT_CRASH);
  }

  installSignalHandlers();
  startSocketServer();
}

void main();
