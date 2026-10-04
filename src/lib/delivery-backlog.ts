/**
 * One reading of the daemon's journal-delivery state, shared by `daemon
 * start`/`ensure`, setup's doctor, and the statusline, so the same daemon
 * never reads as draining on one surface and stalled on another.
 *
 * Ingestion health is false whenever any Move has waited past the 30s
 * delivery SLA: either a backlog the daemon is working through or delivery
 * that is failing. Only the failures the daemon has already recorded tell
 * them apart. It counts a drain sweep that threw and a journal scan that
 * failed; a sweep still in flight, or one that bowed out to another process
 * holding the drain lock, records nothing, and re-authentication resets the
 * count. "Draining" therefore means no delivery failure has been recorded,
 * not that delivery is proven.
 */
import { boundedHealthError } from "./ansi.js";

export const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

export type DeliveryIngestion = {
  healthy?: boolean;
  consecutiveFailures?: number;
  lastError?: string;
  pendingCount?: number;
  pendingSampled?: boolean;
  oldestPendingAt?: number;
};

export type PendingBacklog = Pick<
  DeliveryIngestion,
  "pendingCount" | "pendingSampled" | "oldestPendingAt"
>;

/**
 * "draining" or "failing" while ingestion misses its SLA, undefined while it
 * meets it (or is unreported). A missing or malformed failure count is not
 * evidence of progress, so it reads as failing.
 */
export function deliveryBacklogState(
  ingestion: Pick<DeliveryIngestion, "healthy" | "consecutiveFailures"> | undefined,
): "draining" | "failing" | undefined {
  if (ingestion?.healthy !== false) return undefined;
  return ingestion.consecutiveFailures === 0 ? "draining" : "failing";
}

/** Coarse age for an operator line: a weeks-old backlog reads "52d", not seconds. */
function formatBacklogAge(ageMs: number): string {
  if (ageMs >= MS_PER_DAY) return `${String(Math.floor(ageMs / MS_PER_DAY))}d`;
  if (ageMs >= MS_PER_HOUR) return `${String(Math.floor(ageMs / MS_PER_HOUR))}h`;
  if (ageMs >= MS_PER_MINUTE) return `${String(Math.floor(ageMs / MS_PER_MINUTE))}m`;
  return `${String(Math.max(0, Math.floor(ageMs / MS_PER_SECOND)))}s`;
}

/**
 * Describe a pending-Move backlog. A sampled count is a lower bound, so it
 * keeps the same "at least N" wording as the degraded reason and doctor; a
 * zero count from a sample or a failed scan is unknown rather than empty.
 */
export function formatPendingBacklog(backlog: PendingBacklog, now: number = Date.now()): string {
  const count = backlog.pendingCount;
  const moves =
    typeof count === "number" && count > 0
      ? `${backlog.pendingSampled ? "at least " : ""}${String(count)} pending move${count === 1 ? "" : "s"}`
      : "an unknown number of pending moves";
  const age =
    backlog.oldestPendingAt === undefined
      ? ""
      : ` (oldest ${formatBacklogAge(now - backlog.oldestPendingAt)})`;
  return `${moves}${age}`;
}

/**
 * The clause a lifecycle line or doctor appends for a daemon behind its SLA.
 * The daemon owns the durable journal drain, so a backlog, even weeks of
 * Moves captured while auth was dead, is progress to report once the daemon
 * is ready. Recorded delivery failures must never read as draining: they name
 * the failure and the last error instead. `backlog` overrides the counts in
 * `ingestion`, for a caller holding a fresher journal scan.
 */
export function deliveryBacklogSummary(
  ingestion: DeliveryIngestion | undefined,
  now: number = Date.now(),
  backlog: PendingBacklog | undefined = ingestion,
): string | undefined {
  const state = deliveryBacklogState(ingestion);
  if (!(state && ingestion && backlog)) return undefined;
  const pending = formatPendingBacklog(backlog, now);
  if (state === "draining") return `draining ${pending} in the background`;
  const failures = ingestion.consecutiveFailures;
  const count =
    typeof failures === "number" && Number.isInteger(failures) && failures > 0
      ? ` (${String(failures)} consecutive failure${failures === 1 ? "" : "s"})`
      : "";
  const error = boundedHealthError(ingestion.lastError);
  return `delivery failing${count}${error ? `: ${error}` : ""} · retrying ${pending} in the background`;
}
