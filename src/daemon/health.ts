import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { primConfigDirectory } from "../lib/paths.js";

const CONFIG_DIR_MODE = 0o700;
const HEALTH_FILE_MODE = 0o600;
export const INGESTION_SLA_MS = 30_000;
export const HEARTBEAT_FRESH_MS = 90_000;
export const HEARTBEAT_RETRY_CAP_MS = 30_000;
export const INGESTION_RETRY_BASE_MS = 5_000;
export const INGESTION_RETRY_CAP_MS = 15_000;

export const DAEMON_HEALTH_PATH = join(primConfigDirectory(), "daemon-health.json");

export interface DaemonHeartbeatHealth {
  healthy: boolean;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastRejectedAt?: number;
  lastError?: string;
  consecutiveFailures: number;
  nextRetryAt?: number;
}

export interface DaemonIngestionHealth {
  healthy: boolean;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  consecutiveFailures: number;
  pendingCount: number;
  pendingSampled: boolean;
  oldestPendingAt?: number;
  strandedCount: number;
  /** Moves the last completed sweep acknowledged, across all its drains. */
  lastAcknowledgedCount: number;
  /**
   * Of lastAcknowledgedCount, the Moves acknowledged by the drains that then
   * failed, before they failed (FlushError.failedDrainFlushed). Delivery
   * state credits a failed sweep as draining only on this count, never on
   * another bucket's delivery. Zero after a successful sweep, a failure
   * outside a drain, and a credential change.
   */
  lastFailedDrainAcknowledgedCount: number;
  /**
   * Journal buckets the last completed sweep held back instead of sending
   * (unbound, another organization, identity unavailable, ...), and their
   * `reason:count` summary. Such a sweep can succeed while those Moves never
   * deliver, so delivery state must not read it as draining. Zero until a
   * sweep holds a bucket back, and reset by a credential change. Daemons
   * that predate the field omit it, and delivery state reads that as
   * unknown, never as draining.
   */
  lastRetainedBucketCount: number;
  lastRetainedReasons?: string;
  nextRetryAt?: number;
}

export interface DaemonHealthState {
  schemaVersion: 1;
  version: string;
  pid: number;
  /**
   * The API base URL this daemon delivers to. Journals are partitioned by
   * deployment and the daemon drains only its own partition, so a CLI
   * targeting another deployment cannot leave its drain to this daemon.
   * Absent from daemons that predate the field.
   */
  siteUrl?: string;
  startedAt: number;
  updatedAt: number;
  healthy: boolean;
  heartbeat: DaemonHeartbeatHealth;
  ingestion: DaemonIngestionHealth;
  // Set once the broker terminally ends the session ("invalid_grant"). The
  // daemon has halted its poll loops and is waiting for `prim auth login`;
  // doctor renders this as an actionable re-auth prompt rather than an opaque
  // "heartbeat unhealthy — HTTP 500".
  needsReauth?: boolean;
}

export function createDaemonHealthState(
  version: string,
  pid: number,
  startedAt: number,
  siteUrl?: string,
): DaemonHealthState {
  return {
    schemaVersion: 1,
    version,
    pid,
    siteUrl,
    startedAt,
    updatedAt: startedAt,
    healthy: false,
    heartbeat: { healthy: false, consecutiveFailures: 0 },
    ingestion: {
      healthy: true,
      consecutiveFailures: 0,
      pendingCount: 0,
      pendingSampled: false,
      strandedCount: 0,
      lastAcknowledgedCount: 0,
      lastFailedDrainAcknowledgedCount: 0,
      lastRetainedBucketCount: 0,
    },
  };
}

/** Recompute stable booleans from the recorded timestamps and queue state. */
export function refreshDaemonHealth(state: DaemonHealthState, now: number): void {
  state.heartbeat.healthy =
    state.heartbeat.consecutiveFailures === 0 &&
    state.heartbeat.lastSuccessAt !== undefined &&
    now - state.heartbeat.lastSuccessAt < HEARTBEAT_FRESH_MS;
  state.ingestion.healthy =
    state.ingestion.consecutiveFailures === 0 &&
    !state.ingestion.pendingSampled &&
    (state.ingestion.pendingCount === 0 ||
      (state.ingestion.oldestPendingAt !== undefined &&
        now - state.ingestion.oldestPendingAt <= INGESTION_SLA_MS));
  state.healthy = state.heartbeat.healthy && state.ingestion.healthy && !state.needsReauth;
}

function retryDelayMs(consecutiveFailures: number, capMs: number, random: () => number): number {
  const exponent = Math.max(0, consecutiveFailures - 1);
  const base = Math.min(capMs, INGESTION_RETRY_BASE_MS * 2 ** exponent);
  const jitter = 0.8 + Math.min(1, Math.max(0, random())) * 0.4;
  return Math.min(capMs, Math.round(base * jitter));
}

export function heartbeatRetryDelayMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  return retryDelayMs(consecutiveFailures, HEARTBEAT_RETRY_CAP_MS, random);
}

export function ingestionRetryDelayMs(
  consecutiveFailures: number,
  random: () => number = Math.random,
): number {
  return retryDelayMs(consecutiveFailures, INGESTION_RETRY_CAP_MS, random);
}

/** Atomically persist diagnostics without ever relaxing their file mode. */
export function writeDaemonHealthState(
  state: DaemonHealthState,
  path: string = DAEMON_HEALTH_PATH,
): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: CONFIG_DIR_MODE });
  }
  const tmp = join(dir, `.${process.pid}.daemon-health.tmp`);
  writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: HEALTH_FILE_MODE });
  chmodSync(tmp, HEALTH_FILE_MODE);
  renameSync(tmp, path);
}
