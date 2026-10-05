/**
 * One reading of the daemon's journal-delivery state, shared by `daemon
 * start`/`ensure`, setup's doctor, and the statusline, so the same daemon
 * never reads as draining on one surface and stalled on another.
 *
 * Ingestion health is false whenever any Move has waited past the 30s
 * delivery SLA: a backlog the daemon is working through, organization buckets
 * it holds back without sending, or delivery that is failing. Only what the
 * daemon recorded about its last sweep tells them apart:
 *
 * - "failing": a recorded failure (a sweep that threw, or a journal scan that
 *   failed) whose sweep acknowledged nothing.
 * - "retained": the last completed sweep held buckets back (unbound, another
 *   organization, identity unavailable, ...). Those Moves cannot deliver
 *   until someone acts, so this is never draining, however the sweep ended.
 * - "draining": no recorded failure, or the failed sweep still acknowledged
 *   Moves first, so the backlog is advancing.
 *
 * A sweep still in flight, or one that bowed out to another process holding
 * the drain lock, records nothing, and re-authentication resets the failure
 * count. "Draining" therefore means no stall has been recorded, not that
 * delivery is proven.
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
  lastAcknowledgedCount?: number;
  lastRetainedBucketCount?: number;
  lastRetainedReasons?: string;
};

export type DeliveryBacklogState = "draining" | "retained" | "failing";

export type PendingBacklog = Pick<
  DeliveryIngestion,
  "pendingCount" | "pendingSampled" | "oldestPendingAt"
>;

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

/**
 * The delivery state while ingestion misses its SLA (see the module comment),
 * undefined while it meets it (or is unreported). A missing or malformed
 * failure count is not evidence of progress, so it reads as failing.
 */
export function deliveryBacklogState(
  ingestion:
    | Pick<
        DeliveryIngestion,
        "healthy" | "consecutiveFailures" | "lastAcknowledgedCount" | "lastRetainedBucketCount"
      >
    | undefined,
): DeliveryBacklogState | undefined {
  if (ingestion?.healthy !== false) return undefined;
  const failures = ingestion.consecutiveFailures;
  // A failed sweep that acknowledged Moves before failing still advanced the
  // backlog, so only a failure without that progress reads as failing.
  const failedWithoutProgress =
    failures !== 0 &&
    !(isPositiveInteger(failures) && isPositiveInteger(ingestion.lastAcknowledgedCount));
  if (failedWithoutProgress) return "failing";
  if (isPositiveInteger(ingestion.lastRetainedBucketCount)) return "retained";
  return "draining";
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
 * zero count from a sample or a failed scan is unknown rather than empty. A
 * sample's oldest timestamp is likewise a lower bound on the age, since the
 * files it did not read can hold older Moves.
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
      : ` (oldest ${backlog.pendingSampled ? "≥ " : ""}${formatBacklogAge(now - backlog.oldestPendingAt)})`;
  return `${moves}${age}`;
}

/**
 * The clause a lifecycle line or doctor appends for a daemon behind its SLA.
 * The daemon owns the durable journal drain, so a backlog, even weeks of
 * Moves captured while auth was dead, is progress to report once the daemon
 * is ready. Held-back buckets and recorded delivery failures must never read
 * as draining: they name the retention reasons, or the failure and the last
 * error, instead. `backlog` overrides the counts in `ingestion`, for a caller
 * holding a fresher journal scan.
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
  if (state === "retained") {
    const buckets = ingestion.lastRetainedBucketCount ?? 0;
    const reasons = boundedHealthError(ingestion.lastRetainedReasons);
    return `delivery held back: ${String(buckets)} organization bucket${buckets === 1 ? "" : "s"} retained${reasons ? ` (${reasons})` : ""} · holding ${pending} — run \`prim doctor\``;
  }
  const failures = ingestion.consecutiveFailures;
  const count = isPositiveInteger(failures)
    ? ` (${String(failures)} consecutive failure${failures === 1 ? "" : "s"})`
    : "";
  const error = boundedHealthError(ingestion.lastError);
  return `delivery failing${count}${error ? `: ${error}` : ""} · retrying ${pending} in the background`;
}
