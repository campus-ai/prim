import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const CONFIG_DIR_MODE = 0o700;
const HEALTH_FILE_MODE = 0o600;
export const INGESTION_SLA_MS = 30_000;
export const HEARTBEAT_FRESH_MS = 90_000;
export const HEARTBEAT_RETRY_CAP_MS = 30_000;
export const INGESTION_RETRY_BASE_MS = 5_000;
export const INGESTION_RETRY_CAP_MS = 15_000;

export const DAEMON_HEALTH_PATH = join(homedir(), ".config", "prim", "daemon-health.json");

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
  lastAcknowledgedCount: number;
  nextRetryAt?: number;
}

export interface DaemonHealthState {
  schemaVersion: 1;
  version: string;
  pid: number;
  startedAt: number;
  updatedAt: number;
  healthy: boolean;
  heartbeat: DaemonHeartbeatHealth;
  ingestion: DaemonIngestionHealth;
}

export function createDaemonHealthState(
  version: string,
  pid: number,
  startedAt: number,
): DaemonHealthState {
  return {
    schemaVersion: 1,
    version,
    pid,
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
  state.healthy = state.heartbeat.healthy && state.ingestion.healthy;
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
