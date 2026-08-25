#!/usr/bin/env node
/**
 * `prim-daemon-server` — long-lived per-user companion for the prim hooks.
 *
 * Opens a Unix socket under Primitive's resolved config directory that decision reads plus the
 * SessionStart / SessionEnd hooks proxy through; amortizes the token-refresh
 * check; and heartbeats `agentPresence` every 30s, caching the online count
 * and the teammate-name roster the ack returns so a statusline can render
 * "team: Maya, Alex +2" (and `daemon status` the full list). It also maintains
 * the local Decision-feed snapshot consumed by latency-sensitive Codex hooks.
 *
 * Lifecycle: `prim daemon start` spawns this bin detached. SIGTERM (or
 * `prim daemon stop`) cleans up the socket + pidfile. Refuses to start if an
 * existing pid is still alive.
 *
 * Fail-soft: every hook also retains its direct HTTP path. If the daemon is
 * down, hooks degrade to ~200ms instead of ~30ms; never to an outright block.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { type Server, type Socket, createServer } from "node:net";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  getClient,
  getSiteUrl,
  getSiteUrlForEnvironment,
  getTokenExpiresAt,
  isSessionEnded,
  refreshToken,
  resolveAuthCredential,
} from "../client.js";
import { FlushError, flush } from "../flusher.js";
import { pendingJournalStats } from "../journal.js";
import { decisionIngestionStatus, repositoryBindingState } from "../lib/activation.js";
import { primConfigDirectory } from "../lib/paths.js";
import type { Teammate } from "../lib/presence.js";
import {
  type StatusSnapshot,
  StatuslineIngestionCache,
  formatStatusline,
} from "../lib/statusline-render.js";
import { daemonRequest } from "./client.js";
import { DECISION_DIGEST_CACHE_PATH, DecisionDigestCache } from "./decision-digest-cache.js";
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
import {
  daemonPrincipalsMatch,
  resolveDaemonCredentialKey,
  resolveDaemonPrincipal,
} from "./principal.js";
import {
  DAEMON_JSON_REQUEST_MAX_BYTES,
  DAEMON_JSON_RESPONSE_MAX_BYTES,
  DAEMON_SOCKET_IDLE_TIMEOUT_MS,
  type DaemonRequestEnvelope,
  type DaemonResponseEnvelope,
  parseDaemonRequestEnvelope,
} from "./protocol.js";
import {
  STATUSLINE_PROTOCOL_PREFIX,
  STATUSLINE_REQUEST_MAX_BYTES,
  isStatuslineRequestPrefix,
  parseStatuslineRequest,
} from "./statusline-protocol.js";

const CONFIG_DIR = primConfigDirectory();
const SOCK_PATH = join(CONFIG_DIR, "sock");
const CONFIG_DIR_MODE = 0o700;
const SOCKET_MODE = 0o600;
const MAX_SOCKET_CONNECTIONS = 64;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

const HEARTBEAT_INTERVAL_MS = 30_000;
const INGESTION_POLL_INTERVAL_MS = 15_000;
const DECISION_DIGEST_POLL_INTERVAL_MS = 5_000;
const TOKEN_CHECK_INTERVAL_MS = 60_000;
const TOKEN_REFRESH_THRESHOLD_MS = 90_000;
const HTTP_PROXY_TIMEOUT_MS = 10_000;
// How long cached presence (count + names) stays trustworthy after the last
// accepted heartbeat (≈ 3 heartbeat cadences). Past this, the daemon is alive
// but its heartbeats are failing, so the frozen data is reported as stale.
const PRESENCE_FRESH_WINDOW_MS = 90_000;
const EXIT_OK = 0;
const EXIT_CRASH = 1;

const startedAt = Date.now();
const client = getClient();
const runtimeVersion = resolveRuntimeVersion();
const daemonHealth = createDaemonHealthState(runtimeVersion, process.pid, startedAt);
const statuslineIngestionCache = new StatuslineIngestionCache(decisionIngestionStatus, {
  resolveRepositoryBindingState: repositoryBindingState,
});
const decisionDigestCache = new DecisionDigestCache(
  async () =>
    await client.get(DECISION_DIGEST_CACHE_PATH, {
      signal: AbortSignal.timeout(HTTP_PROXY_TIMEOUT_MS),
    }),
);
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
let decisionDigestTimer: NodeJS.Timeout | undefined;
let tokenCheckTimer: NodeJS.Timeout | undefined;
let heartbeatInFlight: Promise<void> | undefined;
let heartbeatRerunRequested = false;
let ownership: DaemonOwnership | undefined;
let socketServer: Server | undefined;
let shuttingDown = false;
let activeCredentialKey = resolveDaemonCredentialKey();
// Set once the broker terminally ends the session (isSessionEnded()). The
// heartbeat + ingestion loops halt — replaying a dead token every poll was the
// server-side 500 flood — while the slower token-check loop keeps running to
// auto-resume once `prim auth login` rotates in a fresh token.
let reauthHold = false;

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

function purgePrincipalScopedState(): void {
  decisionDigestCache.reset();
  statuslineIngestionCache.clear();
  lastHeartbeatAt = undefined;
  lastOnlineCount = undefined;
  lastOnlineNames = undefined;
  lastOnlineTeammates = undefined;
  lastOkAtLocal = undefined;
}

/** Re-read the credential generation before every tenant-scoped socket or cache operation. */
function synchronizeDaemonCredential(): ReturnType<typeof resolveDaemonPrincipal> {
  const token = resolveAuthCredential()?.token;
  const credentialKey = resolveDaemonCredentialKey(token);
  if (credentialKey !== activeCredentialKey) {
    activeCredentialKey = credentialKey;
    purgePrincipalScopedState();
  }
  return resolveDaemonPrincipal(token);
}

function assertCallerPrincipalMatches(caller: DaemonRequestEnvelope["caller"]): string {
  const daemonPrincipal = synchronizeDaemonCredential();
  const credentialKey = activeCredentialKey;
  if (!(credentialKey && daemonPrincipalsMatch(caller, daemonPrincipal))) {
    throw new Error("daemon caller principal or organization mismatch");
  }
  return credentialKey;
}

function ensureDaemonDirectoryPermissions(): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: CONFIG_DIR_MODE });
  chmodSync(CONFIG_DIR, CONFIG_DIR_MODE);
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

/**
 * Halt the heartbeat, ingestion, and Decision-cache loops after the broker has terminally ended
 * the session. Retrying can't help — only `prim auth login` can — so replaying
 * the dead token every poll just floods the server with 401s (previously 500s)
 * and feeds the broker's reuse detection. Captures still accrue to the journal
 * and drain once the token-check loop detects re-auth. Idempotent.
 */
function enterReauthHold(): void {
  if (reauthHold) {
    return;
  }
  reauthHold = true;
  daemonHealth.needsReauth = true;
  if (heartbeatTimer) {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = undefined;
  }
  if (ingestionTimer) {
    clearTimeout(ingestionTimer);
    ingestionTimer = undefined;
  }
  if (decisionDigestTimer) {
    clearTimeout(decisionDigestTimer);
    decisionDigestTimer = undefined;
  }
  persistHealth();
  // One line, not one per poll: the whole point is to stop the spam.
  process.stderr.write(
    "[prim-daemon] authentication ended — halting heartbeat + ingestion + Decision cache until `prim auth login` (captures continue to the journal)\n",
  );
}

/**
 * Resume the loops once a fresh `prim auth login` has rotated in a new refresh
 * token (isSessionEnded() reverts to false on its own). Clears the failure
 * counters so backoff restarts clean.
 */
function exitReauthHold(): void {
  if (!reauthHold) {
    return;
  }
  reauthHold = false;
  daemonHealth.needsReauth = false;
  daemonHealth.heartbeat.consecutiveFailures = 0;
  daemonHealth.ingestion.consecutiveFailures = 0;
  daemonHealth.heartbeat.lastError = undefined;
  daemonHealth.ingestion.lastError = undefined;
  persistHealth();
  process.stderr.write(
    "[prim-daemon] re-authentication detected — resuming heartbeat + ingestion + Decision cache\n",
  );
  void sendHeartbeat();
  void runIngestionLoop();
  void runDecisionDigestLoop();
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
  synchronizeDaemonCredential();
  const requestCredentialKey = activeCredentialKey;
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
    synchronizeDaemonCredential();
    if (requestCredentialKey !== activeCredentialKey) {
      // Never publish a heartbeat response from the credential generation
      // that just rotated away. Rerun once under the new generation instead.
      heartbeatRerunRequested = true;
      return;
    }
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
    if (isSessionEnded()) {
      enterReauthHold();
      return;
    }
    process.stderr.write(`[prim-daemon] heartbeat error: ${errorMessage(err)}\n`);
  }
}

/** Collapse concurrent timer/session requests into one heartbeat, then rerun
 * once if the active session changed while that request was in flight. */
function sendHeartbeat(): Promise<void> {
  if (shuttingDown || reauthHold) {
    return Promise.resolve();
  }
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
    } while (heartbeatRerunRequested && !(shuttingDown || reauthHold));
  })().finally(() => {
    heartbeatInFlight = undefined;
    scheduleHeartbeat();
  });
  return heartbeatInFlight;
}

function scheduleHeartbeat(): void {
  if (shuttingDown || reauthHold) {
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
  if (resolveAuthCredential()?.source !== "token_file") {
    return;
  }
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
  if (shuttingDown || reauthHold) {
    return;
  }
  ingestionTimer = setTimeout(() => {
    ingestionTimer = undefined;
    void runIngestionLoop();
  }, delayMs);
}

async function runIngestionLoop(): Promise<void> {
  synchronizeDaemonCredential();
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
    if (result.skipped) {
      // Another prim process holds the drain lock and is draining the shared
      // buckets; reschedule without recording a false success or clearing an
      // outstanding failure. Queue-age health (not this field) governs alerts.
      scheduleIngestion(INGESTION_POLL_INTERVAL_MS);
      return;
    }
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
    if (isSessionEnded()) {
      enterReauthHold();
      return;
    }
    process.stderr.write(`[prim-daemon] ingestion error: ${errorMessage(err)}\n`);
    scheduleIngestion(delay);
  }
}

function scheduleDecisionDigestRefresh(): void {
  if (shuttingDown || reauthHold) return;
  decisionDigestTimer = setTimeout(() => {
    decisionDigestTimer = undefined;
    void runDecisionDigestLoop();
  }, DECISION_DIGEST_POLL_INTERVAL_MS);
}

function refreshDecisionDigest(): Promise<void> {
  synchronizeDaemonCredential();
  return shuttingDown || reauthHold ? Promise.resolve() : decisionDigestCache.refresh();
}

async function runDecisionDigestLoop(): Promise<void> {
  await refreshDecisionDigest();
  scheduleDecisionDigestRefresh();
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

async function proxyGet(
  params: Record<string, unknown>,
  allowedPrefix: string,
  caller: DaemonRequestEnvelope["caller"],
): Promise<unknown> {
  const requestCredentialKey = assertCallerPrincipalMatches(caller);
  // getSiteUrl() fresh (not a boot snapshot) so the guard tracks the very URL
  // request() will hit — both re-resolve from the daemon's fixed env + cwd.
  assertCallerEnvMatches(params.callerEnv, getSiteUrl());
  const path = pathParam(params);
  assertEndpointPath(path, allowedPrefix);
  const result = await client.get(path, { signal: AbortSignal.timeout(HTTP_PROXY_TIMEOUT_MS) });
  if (
    requestCredentialKey !== activeCredentialKey ||
    !daemonPrincipalsMatch(caller, synchronizeDaemonCredential())
  ) {
    throw new Error("daemon credential changed during proxied read");
  }
  return result;
}

function handleStatusSnapshot(
  params: Record<string, unknown>,
  caller?: DaemonRequestEnvelope["caller"],
  enforcePrincipal = false,
): StatusSnapshot {
  const daemonPrincipal = synchronizeDaemonCredential();
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
    launchRevision: process.env.PRIM_LAUNCH_REVISION,
    healthy: daemonHealth.healthy,
    needsReauth: daemonHealth.needsReauth === true,
    heartbeat: { ...daemonHealth.heartbeat },
    ingestion: { ...daemonHealth.ingestion },
  };
  if (enforcePrincipal && !daemonPrincipalsMatch(caller, daemonPrincipal)) {
    return {
      ...base,
      onlineCount: undefined,
      onlineNames: undefined,
      onlineTeammates: undefined,
      presenceStale: false,
      principalMismatch: true,
    };
  }
  // Presence is this daemon's own principal-bound heartbeat. A cross-env caller (e.g. a
  // prod statusline reading a staging-bound daemon) must not see that roster:
  // withhold count/names and flag the mismatch so the statusline shows
  // "presence: other env" instead of another deployment's team. There is no
  // direct fallback for presence, so unlike the proxied reads this withholds
  // rather than throws. Raw statusline v1 has no principal proof, so its
  // dispatcher withholds the roster before reaching this branch.
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

async function dispatchRequest(req: DaemonRequestEnvelope): Promise<DaemonResponseEnvelope> {
  const id = req.id;
  try {
    switch (req.method) {
      case "decisions_recent": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/recent", req.caller);
        return { id, ok: true, result };
      }
      case "decisions_show": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/show", req.caller);
        return { id, ok: true, result };
      }
      case "decisions_cascade": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/cascade", req.caller);
        return { id, ok: true, result };
      }
      case "decisions_affecting": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/affecting", req.caller);
        return { id, ok: true, result };
      }
      case "session_start": {
        assertCallerPrincipalMatches(req.caller);
        if (typeof req.params?.callerEnv !== "string") {
          throw new Error("daemon caller environment is required");
        }
        assertCallerEnvMatches(req.params.callerEnv, getSiteUrl());
        statuslineIngestionCache.clear();
        const sid = req.params?.sessionId;
        if (typeof sid === "string" && sid.length > 0) {
          activeSessionId = sid;
        }
        await sendHeartbeat();
        // Warm the local feed snapshot for the first UserPromptSubmit. This is
        // deliberately detached from the response: SessionStart latency must
        // not depend on the Decision API.
        void refreshDecisionDigest();
        return { id, ok: true, result: { sessionId: activeSessionId } };
      }
      case "session_end": {
        // Keep the daemon heartbeating under its synthesized session id;
        // per-session presence is a later refinement.
        return { id, ok: true, result: { ack: true } };
      }
      case "status_snapshot":
        return {
          id,
          ok: true,
          result: handleStatusSnapshot(req.params ?? {}, req.caller, true),
        };
      case "decision_digest_snapshot": {
        // Unlike the generic read proxy, this never waits on HTTP. Prompt hooks
        // receive the daemon-owned page immediately; the read itself requests
        // an asynchronous refresh that Stop can observe as a backstop.
        assertCallerPrincipalMatches(req.caller);
        assertCallerEnvMatches(req.params?.callerEnv, getSiteUrl());
        const result = decisionDigestCache.read();
        void refreshDecisionDigest();
        return { id, ok: true, result };
      }
      case "statusline_invalidate":
        statuslineIngestionCache.clear();
        return { id, ok: true, result: { ack: true } };
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
  let mode: "undecided" | "statusline" | "json" = "undecided";
  let rawBuffer = Buffer.alloc(0);
  let jsonBuffer = Buffer.alloc(0);
  let dispatched = false;

  conn.setTimeout(DAEMON_SOCKET_IDLE_TIMEOUT_MS, () => conn.end());

  const writeJsonResponse = (response: DaemonResponseEnvelope): void => {
    let payload = Buffer.from(`${JSON.stringify(response)}\n`, "utf8");
    if (payload.length > DAEMON_JSON_RESPONSE_MAX_BYTES) {
      payload = Buffer.from(
        `${JSON.stringify({ id: response.id, ok: false, error: "daemon response too large" })}\n`,
        "utf8",
      );
    }
    conn.end(payload);
  };

  const dispatchJson = (chunk: Buffer): void => {
    if (dispatched || jsonBuffer.length + chunk.length > DAEMON_JSON_REQUEST_MAX_BYTES) {
      conn.end();
      return;
    }
    jsonBuffer = Buffer.concat([jsonBuffer, chunk]);
    const newlineIdx = jsonBuffer.indexOf(0x0a);
    if (newlineIdx === -1) return;

    // The protocol is deliberately one request per connection. Accept only
    // trailing whitespace after the first newline, never pipelined requests.
    const trailing = jsonBuffer.subarray(newlineIdx + 1);
    if (trailing.some((byte) => ![0x09, 0x0a, 0x0d, 0x20].includes(byte))) {
      conn.end();
      return;
    }
    try {
      const line = utf8Decoder.decode(jsonBuffer.subarray(0, newlineIdx));
      const request = parseDaemonRequestEnvelope(JSON.parse(line));
      if (!request) {
        conn.end();
        return;
      }
      dispatched = true;
      conn.pause();
      void dispatchRequest(request).then(writeJsonResponse, () => {
        writeJsonResponse({ id: request.id, ok: false, error: "daemon request failed" });
      });
    } catch {
      conn.end();
    }
  };

  const dispatchStatusline = (): void => {
    const parsed = parseStatuslineRequest(rawBuffer);
    if (parsed.state === "incomplete") {
      return;
    }
    if (parsed.state === "invalid") {
      conn.end();
      return;
    }
    try {
      const callerEnv = getSiteUrlForEnvironment(parsed.request.primApiUrl || undefined);
      // The legacy raw protocol has no caller-principal proof. Preserve its
      // non-secret cross-environment state, but otherwise withhold this
      // daemon's tenant-bound roster.
      const snapshot = handleStatusSnapshot(
        { callerEnv },
        undefined,
        !isCrossEnv(callerEnv, getSiteUrl()),
      );
      const line = formatStatusline(
        runtimeVersion,
        snapshot,
        () => statuslineIngestionCache.get(parsed.request.cwd),
        {
          resolveRepositoryBindingState: () =>
            statuslineIngestionCache.getRepositoryBindingState(parsed.request.cwd),
        },
      );
      conn.end(line);
    } catch {
      conn.end();
    }
  };

  conn.on("data", (chunk) => {
    const bytes = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    if (mode === "json") {
      dispatchJson(bytes);
      return;
    }
    rawBuffer = Buffer.concat([rawBuffer, bytes]);
    if (mode === "statusline") {
      if (rawBuffer.length > STATUSLINE_REQUEST_MAX_BYTES) {
        conn.end();
      } else {
        dispatchStatusline();
      }
      return;
    }

    if (isStatuslineRequestPrefix(rawBuffer)) {
      if (rawBuffer.length >= STATUSLINE_PROTOCOL_PREFIX.length) {
        mode = "statusline";
        dispatchStatusline();
      }
      return;
    }
    mode = "json";
    dispatchJson(rawBuffer);
    rawBuffer = Buffer.alloc(0);
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
  socketServer.maxConnections = MAX_SOCKET_CONNECTIONS;
  socketServer.on("error", (err) => {
    // A bind/runtime socket failure means the daemon cannot serve hooks. Exit
    // non-zero so launchd restarts it; staying PID-alive/socket-dead is never a
    // valid degraded mode.
    shutdown(EXIT_CRASH, `[prim-daemon] fatal socket error: ${err.message}`);
  });
  socketServer.listen(SOCK_PATH, () => {
    try {
      chmodSync(SOCK_PATH, SOCKET_MODE);
    } catch (err) {
      shutdown(EXIT_CRASH, `[prim-daemon] failed to secure socket: ${errorMessage(err)}`);
      return;
    }
    process.stderr.write(`[prim-daemon] listening on ${SOCK_PATH}\n`);
    startTimers();
    process.stderr.write(
      `[prim-daemon] started (pid=${process.pid}, session=${activeSessionId}, version=${runtimeVersion})\n`,
    );
  });
}

function startTimers(): void {
  // Persisted terminal-auth state must take effect before either network loop
  // gets its first chance to replay the rejected refresh generation.
  if (isSessionEnded()) {
    enterReauthHold();
  } else {
    persistHealth();
    void sendHeartbeat();
    void runIngestionLoop();
    void runDecisionDigestLoop();
  }
  void runTokenCheckLoop();
}

async function runTokenCheckLoop(): Promise<void> {
  if (reauthHold) {
    // Held for re-auth: don't refresh a dead token. Watch for a fresh login —
    // isSessionEnded() flips false once the refresh token rotates — and resume
    // the halted loops when it does.
    if (!isSessionEnded() && resolveAuthCredential()) {
      exitReauthHold();
    }
  } else {
    await ensureTokenFresh();
    synchronizeDaemonCredential();
    // A proactive refresh may have hit the terminal rejection; halt promptly
    // rather than waiting for the next heartbeat/ingest to rediscover it.
    if (isSessionEnded()) {
      enterReauthHold();
    }
  }
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
  if (decisionDigestTimer) {
    clearTimeout(decisionDigestTimer);
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
    ensureDaemonDirectoryPermissions();
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
