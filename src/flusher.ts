/**
 * Decision Event Pipeline — flusher.
 *
 * Drains each per-bucket journal to /api/cli/moves/ingest using rotate-
 * then-process so moves appended during the flush window are never lost:
 *
 *   1. Atomically rename <bucket>/journal.ndjson → .flushing.<ts>.<pid>.
 *      Concurrent hook appends start a fresh journal.ndjson; a concurrent
 *      drain that loses the rename race is a no-op (ENOENT).
 *   2. POST batches of up to 500 moves and 1 MiB to /api/cli/moves/ingest,
 *      checkpointing the rotation's byte offset past every durably
 *      acknowledged or quarantined slice (see drain-progress.ts).
 *   3. On success, unlink the .flushing file, then its checkpoint.
 *
 * flush() first re-drains any stranded .flushing files — orphaned when a
 * drain died between the rename and the unlink — then enumerates and drains
 * the live bucket journals. An orphan is adopted only once its owning drain is
 * provably gone (a dead pid, or an aged legacy pid-less file), so a concurrent
 * drain's in-flight file is never stolen out from under it. On a POST failure
 * the .flushing file is left behind for the next sweep, which resumes at its
 * checkpoint, so no moves are lost on a clean failure and none the server
 * acknowledged are re-sent. Before any rotation, one refreshed bearer
 * generation is pinned and its server-derived organization tuple must match
 * each bucket.
 */

import { createReadStream, renameSync, statSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { type CliClient, HttpError } from "./client.js";
import {
  type DeadLetterPersistenceOptions,
  type DeadLetterReason,
  quarantineMove,
  quarantineRawLine,
} from "./dead-letter.js";
import {
  drainResumeOffset,
  removeDrainCheckpoint,
  writeDrainCheckpoint,
} from "./drain-progress.js";
import { requireDurableIngestAcknowledgement } from "./ingest-response.js";
import {
  type CurrentOrganizationBinding,
  InvalidJournalEnvelopeError,
  type RetainedJournalBucket,
  buildOrganizationBoundMoveRequest,
  inspectJournalDelivery,
} from "./journal-organization.js";
import {
  type FlushingFile,
  JOURNAL_DIR,
  type PendingJournalStats,
  listBuckets,
  listFlushing,
  pendingJournalStats,
  sweepOrphanedDrainProgress,
} from "./journal.js";
import { withFileLock } from "./lib/file-lock.js";
import { processIsAlive } from "./lib/process-liveness.js";
import type { Move } from "./protocol/move.js";

const BATCH_SIZE = 500;
// Ingest cost scales with payload bytes, not move count: the server stores
// each large payload before the batch commits, so a count bound alone let a
// batch of large agent payloads outlive HTTP_TIMEOUT_MS even though the server
// went on to commit it. Bounding raw line bytes bounds each POST's upload and
// server time against that timeout; a single larger line is still sent, alone.
export const BATCH_MAX_BYTES = 1_048_576;
const HTTP_TIMEOUT_MS = 10_000;
const OPPORTUNISTIC_FLUSH_AFTER_MS = 60_000;
// A stranded .flushing file is adopted once its owning drain is provably gone.
// A live drain stamps its pid into the filename, so a dead pid is the common
// crash signal; the legacy pid-less variant carries no owner, so it is adopted
// only after aging past this window — long enough that a live in-flight drain
// (bounded by HTTP_TIMEOUT_MS) is never mistaken for an orphan.
const ORPHAN_QUARANTINE_MS = 60_000;

/**
 * Whether a batch already holding `count` moves and `bytes` raw line bytes
 * must be posted before a `nextBytes`-byte line joins it. A batch always takes
 * its first move, so a line over the byte bound is sent alone, never stranded.
 */
function batchIsFull(
  count: number,
  bytes: number,
  nextBytes: number,
  size: number,
  maxBytes: number,
): boolean {
  return count > 0 && (count >= size || bytes + nextBytes > maxBytes);
}

/**
 * Slice a move list into POST batches by the same count and byte bounds the
 * streaming drain applies to raw journal lines, measuring each move as the
 * line appendMoveToPath writes. Pure and order- and identity-preserving, so
 * the batch boundaries can be pinned without a network round-trip.
 */
export function batchMoves(
  moves: Move[],
  size: number = BATCH_SIZE,
  maxBytes: number = BATCH_MAX_BYTES,
): Move[][] {
  const batches: Move[][] = [];
  let batch: Move[] = [];
  let bytes = 0;
  for (const move of moves) {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(move)}\n`);
    if (batchIsFull(batch.length, bytes, lineBytes, size, maxBytes)) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(move);
    bytes += lineBytes;
  }
  if (batch.length > 0) {
    batches.push(batch);
  }
  return batches;
}

export type DrainCounts = { flushed: number; quarantined: number };

function addDrainCounts(left: DrainCounts, right: DrainCounts): DrainCounts {
  return {
    flushed: left.flushed + right.flushed,
    quarantined: left.quarantined + right.quarantined,
  };
}

/** Legacy journal entries can be valid enough to deliver without env provenance. */
function collectionScopeRoots(batch: readonly Move[]): string[] {
  return batch.flatMap((move) => {
    const env = (move as { env?: unknown }).env;
    if (typeof env !== "object" || env === null || Array.isArray(env)) return [];
    const record = env as Record<string, unknown>;
    const root = typeof record.gitRoot === "string" ? record.gitRoot : record.cwd;
    return typeof root === "string" && root.length > 0 ? [root] : [];
  });
}

function isVersionedInvalidMoveDisposition(body: unknown): boolean {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return false;
  }
  const record = body as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 && record.error === "invalid_move" && record.errorVersion === 1
  );
}

function deadLetterReason(error: unknown): DeadLetterReason | undefined {
  if (error instanceof InvalidJournalEnvelopeError) {
    return "invalid_move";
  }
  if (!(error instanceof HttpError)) {
    return undefined;
  }
  if (error.status === 400 && isVersionedInvalidMoveDisposition(error.body)) {
    return "invalid_move";
  }
  if (
    error.status === 409 &&
    typeof error.body === "object" &&
    error.body !== null &&
    !Array.isArray(error.body)
  ) {
    const errorCode = (error.body as Record<string, unknown>).error;
    if (errorCode === "move_id_conflict") {
      return "move_id_conflict";
    }
    if (errorCode === "capture_authority_mismatch") {
      return "tenant_mismatch";
    }
  }
  return undefined;
}

/**
 * A server fault or client timeout may be caused by the batch's size alone
 * (Convex per-transaction read limits), so halves are worth retrying. A 503
 * is the server's explicit "not now" and says nothing about the batch.
 */
function mayBeBatchSizeFailure(error: unknown): boolean {
  if (error instanceof HttpError) {
    return error.status >= 500 && error.status !== 503;
  }
  return error instanceof Error && error.name === "TimeoutError";
}

type JournalLine = { bytes: Buffer; end: number };
type JournalEntry = { move: Move; end: number };

/**
 * Stream exact NDJSON line bytes without lossy UTF-8 replacement. Each line
 * carries its end offset from the start of the file (the stream begins at
 * `offset`), so a drain can checkpoint exactly past the lines it retired.
 */
async function* rawJournalLines(
  input: ReturnType<typeof createReadStream>,
  offset: number,
): AsyncGenerator<JournalLine> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let end = offset;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    let newline = chunk.indexOf(0x0a, start);
    while (newline !== -1) {
      // Include LF so raw quarantine preserves CRLF vs LF precisely.
      const tail = chunk.subarray(start, newline + 1);
      let line = tail;
      if (pending.length > 0) {
        pending.push(tail);
        line = Buffer.concat(pending, pendingBytes + tail.length);
        pending = [];
        pendingBytes = 0;
      }
      end += line.length;
      yield { bytes: line, end };
      start = newline + 1;
      newline = chunk.indexOf(0x0a, start);
    }
    if (start < chunk.length) {
      const tail = chunk.subarray(start);
      pending.push(tail);
      pendingBytes += tail.length;
    }
  }
  if (pendingBytes > 0) {
    const bytes = pending.length === 1 ? pending[0] : Buffer.concat(pending, pendingBytes);
    yield { bytes, end: end + pendingBytes };
  }
}

/**
 * Drain an already-rotated `.flushing` file: POST its moves in batches, then
 * unlink on success. On a POST failure it throws WITHOUT unlinking, so the
 * file stays on disk for the next sweep — no moves are lost on a clean
 * failure. Progress is checkpointed past every durably acknowledged or
 * quarantined slice, so that sweep resumes at the first unacknowledged line
 * instead of re-POSTing batches the server already committed — including one
 * it committed after this client timed out. Shared by the normal rotate path
 * and orphan recovery.
 */
export async function drainFlushingPath(
  flushingPath: string,
  client: CliClient,
  binding: CurrentOrganizationBinding,
  options: { deadLetterPersistence?: DeadLetterPersistenceOptions } = {},
): Promise<DrainCounts> {
  // The rotation's size pins which bytes a checkpoint describes.
  const size = statSync(flushingPath).size;
  const resumeAt = drainResumeOffset(flushingPath, size);
  let progressWarned = false;
  const recordProgress = (retired: readonly JournalEntry[]): void => {
    const last = retired.at(-1);
    if (last === undefined) {
      return;
    }
    try {
      writeDrainCheckpoint(flushingPath, { v: 1, offset: last.end, size });
    } catch (error) {
      // Progress saves replays; it is never a delivery precondition. A failed
      // write leaves an older checkpoint that only re-sends deduped moves.
      if (!progressWarned) {
        progressWarned = true;
        process.stderr.write(
          `[prim] could not record drain progress: ${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
    }
  };

  const postBatch = async (batch: JournalEntry[]): Promise<DrainCounts> => {
    const moves = batch.map((entry) => entry.move);
    try {
      const request = buildOrganizationBoundMoveRequest(moves, binding);
      const response = await client.post("/api/cli/moves/ingest", request, {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      requireDurableIngestAcknowledgement(response, moves.length, collectionScopeRoots(moves));
    } catch (error) {
      const reason = deadLetterReason(error);
      if (!(reason || mayBeBatchSizeFailure(error))) {
        throw error;
      }
      if (batch.length > 1) {
        // Ingest rejects a batch atomically. Bisect closed permanent
        // dispositions so valid neighbors can be durably acknowledged while
        // the exact offending envelope is isolated locally, and possible
        // size failures so an oversized batch cannot block the journal.
        // Halves run left then right and any failing leaf throws, so the
        // leaves that return always form a contiguous, checkpointable prefix.
        const midpoint = Math.floor(batch.length / 2);
        const left = await postBatch(batch.slice(0, midpoint));
        const right = await postBatch(batch.slice(midpoint));
        return addDrainCounts(left, right);
      }
      if (!reason) {
        // A single move is never dead-lettered for a transient failure; the
        // rotation stays on disk for the next sweep.
        throw error;
      }
      const [entry] = batch;
      const quarantined = quarantineMove(
        flushingPath,
        entry.move,
        reason,
        Date.now,
        options.deadLetterPersistence,
      );
      recordProgress(batch);
      process.stderr.write(
        `[prim] quarantined rejected move ${quarantined.quarantineId.slice(0, 12)} (${reason})\n`,
      );
      return { flushed: 0, quarantined: 1 };
    }
    recordProgress(batch);
    return { flushed: batch.length, quarantined: 0 };
  };

  const input = createReadStream(flushingPath, { start: resumeAt });
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let batch: JournalEntry[] = [];
  let batchBytes = 0;
  let counts: DrainCounts = { flushed: 0, quarantined: 0 };
  try {
    for await (const { bytes: rawLine, end } of rawJournalLines(input, resumeAt)) {
      if (
        (rawLine.length === 1 && rawLine[0] === 0x0a) ||
        (rawLine.length === 2 && rawLine[0] === 0x0d && rawLine[1] === 0x0a)
      ) {
        continue;
      }
      let move: Move;
      try {
        const line = decoder.decode(rawLine);
        move = JSON.parse(line) as Move;
      } catch {
        const quarantined = quarantineRawLine(
          flushingPath,
          rawLine,
          Date.now,
          options.deadLetterPersistence,
        );
        process.stderr.write(
          `[prim] quarantined invalid journal line ${quarantined.quarantineId.slice(0, 12)} (invalid_move)\n`,
        );
        counts.quarantined += 1;
        // Already durable, so the next checkpoint may pass it. Trailing invalid
        // lines need no checkpoint: the rotation is unlinked after them, and a
        // replay from the last move's checkpoint re-quarantines them idempotently.
        continue;
      }
      if (batchIsFull(batch.length, batchBytes, rawLine.length, BATCH_SIZE, BATCH_MAX_BYTES)) {
        counts = addDrainCounts(counts, await postBatch(batch));
        batch = [];
        batchBytes = 0;
      }
      batch.push({ move, end });
      batchBytes += rawLine.length;
    }
    if (batch.length > 0) {
      counts = addDrainCounts(counts, await postBatch(batch));
    }
  } finally {
    input.destroy();
  }
  unlinkSync(flushingPath);
  // Only after the rotation is gone: a crash between the two unlinks leaves an
  // orphaned checkpoint for sweepOrphanedDrainProgress, never a rotation that
  // lost its progress.
  try {
    removeDrainCheckpoint(flushingPath);
  } catch {
    // Delivery is complete; the next flush sweeps the orphan.
  }
  return counts;
}

async function drainPath(
  path: string,
  client: CliClient,
  binding: CurrentOrganizationBinding,
): Promise<DrainCounts> {
  const tmpPath = `${path}.flushing.${String(Date.now())}.${String(process.pid)}`;
  try {
    renameSync(path, tmpPath);
  } catch (err) {
    // No journal at this path, or a concurrent drain already rotated it.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { flushed: 0, quarantined: 0 };
    }
    throw err;
  }

  return drainFlushingPath(tmpPath, client, binding);
}

/**
 * Filter stranded `.flushing` files down to the ones safe to re-drain: a dead
 * owning pid, or a legacy pid-less file aged past the quarantine window. Pure
 * (the aliveness probe is injectable) so the safety boundary is unit-pinned.
 */
export function selectRecoverable(
  files: FlushingFile[],
  now: number,
  opts: {
    quarantineMs?: number;
    isAlive?: (pid: number) => boolean;
    ownerPid?: number;
  } = {},
): FlushingFile[] {
  const quarantineMs = opts.quarantineMs ?? ORPHAN_QUARANTINE_MS;
  const isAlive = opts.isAlive ?? processIsAlive;
  return files.filter((f) => {
    if (f.pid === undefined) {
      return now - f.mtimeMs > quarantineMs;
    }
    // A failed drain in this process leaves its own rotation behind. flush()
    // is single-flight below, so reclaiming that file on the next attempt
    // cannot steal it from another in-process request.
    return f.pid === opts.ownerPid || !isAlive(f.pid);
  });
}

/**
 * Re-drain stranded `.flushing` files left by a drain that died between the
 * rename and the unlink. Each recoverable file resumes at its drain checkpoint
 * and is re-POSTed under its original moveIds (the server dedups at
 * by_move_id, so lines delivered after the last checkpoint replay
 * harmlessly), then unlinked. A file whose POST fails is left for the next
 * sweep rather than aborting recovery of the rest.
 */
export type DrainSummary = DrainCounts & { errors: unknown[]; failedBuckets: Set<string> };

export async function recoverOrphans(
  candidates: FlushingFile[],
  options: {
    now?: number;
    ownerPid?: number;
    isAlive?: (pid: number) => boolean;
    drain: (path: string) => Promise<DrainCounts>;
  },
): Promise<DrainSummary> {
  const summary: DrainSummary = {
    flushed: 0,
    quarantined: 0,
    errors: [],
    failedBuckets: new Set(),
  };
  const recoverable = selectRecoverable(candidates, options.now ?? Date.now(), {
    ownerPid: options.ownerPid ?? process.pid,
    isAlive: options.isAlive,
  }).sort((a, b) => a.mtimeMs - b.mtimeMs || a.path.localeCompare(b.path));
  const drain = options.drain;
  for (const file of recoverable) {
    if (summary.failedBuckets.has(file.bucket)) {
      continue;
    }
    try {
      const counts = await drain(file.path);
      summary.flushed += counts.flushed;
      summary.quarantined += counts.quarantined;
    } catch (err) {
      // Leave this orphan on disk for a later sweep; keep recovering the rest.
      summary.errors.push(err);
      summary.failedBuckets.add(file.bucket);
    }
  }
  return summary;
}

export class FlushError extends Error {
  readonly flushed: number;
  readonly quarantined: number;

  constructor(cause: unknown, flushed: number, quarantined: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "FlushError";
    this.flushed = flushed;
    this.quarantined = quarantined;
  }
}

async function flushOnce(): Promise<
  DrainCounts & {
    retained?: RetainedJournalBucket[];
  }
> {
  // A drain that died between retiring a rotation and its checkpoint leaves
  // only the checkpoint; drop those before any drain of this sweep starts.
  sweepOrphanedDrainProgress();
  // Reclaim crash-stranded orphans first, then drain the live buckets.
  // Path-only enumeration (listBuckets does not stat/read), so the only
  // race-sensitive op is drainPath's ENOENT-tolerant rename.
  const orphanCandidates = listFlushing({ sampleBytes: 0 });
  const liveBuckets = listBuckets();
  if (orphanCandidates.length === 0 && liveBuckets.length === 0) {
    return { flushed: 0, quarantined: 0 };
  }
  const inspection = await inspectJournalDelivery([
    ...orphanCandidates.map((file) => file.bucket),
    ...liveBuckets.map((bucket) => bucket.bucket),
  ]);
  if (!(inspection.client && inspection.binding)) {
    return { flushed: 0, quarantined: 0, retained: inspection.retainedBuckets };
  }
  const client = inspection.client;
  const binding = inspection.binding;
  const recovered = await recoverOrphans(
    orphanCandidates.filter((file) => inspection.deliverableBuckets.has(file.bucket)),
    { drain: (path) => drainFlushingPath(path, client, binding) },
  );
  let total = recovered.flushed;
  let quarantined = recovered.quarantined;
  const errors = recovered.errors;
  for (const { bucket, path } of liveBuckets) {
    if (!inspection.deliverableBuckets.has(bucket)) {
      continue;
    }
    // Do not create one new failed rotation per retry while a prior rotation
    // for this bucket is still undeliverable (for example, capture disabled).
    // Other buckets remain independent and continue draining.
    if (recovered.failedBuckets.has(bucket)) {
      continue;
    }
    try {
      const counts = await drainPath(path, client, binding);
      total += counts.flushed;
      quarantined += counts.quarantined;
    } catch (err) {
      // One broken/disabled bucket must not prevent independent buckets from
      // draining. Every failed rotation remains on disk for the next attempt.
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new FlushError(errors[0], total, quarantined);
  }
  return inspection.retainedBuckets.length > 0
    ? { flushed: total, quarantined, retained: inspection.retainedBuckets }
    : { flushed: total, quarantined };
}

// `skipped` distinguishes a contended bow-out (another process holds the drain
// lock) from a genuine empty-journal drain, so the daemon does not record a
// false success and `prim moves flush` does not imply the journal was empty.
export type FlushResult = DrainCounts & {
  skipped?: boolean;
  retained?: RetainedJournalBucket[];
};

let flushInFlight: Promise<FlushResult> | undefined;

// Serialize drains ACROSS prim processes, not just within one. The Stop hook
// spawns a detached `prim moves flush` while the daemon and opportunistic
// command flushes also run, so multiple processes can otherwise adopt the same
// crash-stranded `.flushing` orphans and re-POST them concurrently — the
// amplification behind the incident's duplicate-ingest flood. A contended
// caller bows out (the lock holder drains its buckets and orphans); the moves
// stay journaled for the next trigger. The lock sits beside the moves tree so
// listBuckets never enumerates it as a bucket.
const FLUSH_LOCK_PATH = join(dirname(JOURNAL_DIR), ".flush.lock");
const FLUSH_LOCK_TIMEOUT_MS = 250;

function isFlushLockContended(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("timed out waiting for file lock");
}

/** Serialize drains within AND across processes so rotations are never stolen. */
export function flush(): Promise<FlushResult> {
  if (flushInFlight) {
    return flushInFlight;
  }
  const attempt = withFileLock(FLUSH_LOCK_PATH, flushOnce, {
    timeoutMs: FLUSH_LOCK_TIMEOUT_MS,
  })
    .catch((error: unknown): FlushResult => {
      // Another prim process holds the drain lock and will drain these buckets
      // and orphans; bowing out avoids the concurrent re-drain. Non-contention
      // failures (a real drain error) still propagate to the caller.
      if (isFlushLockContended(error)) {
        return { flushed: 0, quarantined: 0, skipped: true };
      }
      throw error;
    })
    .finally(() => {
      if (flushInFlight === attempt) {
        flushInFlight = undefined;
      }
    });
  flushInFlight = attempt;
  return attempt;
}

export function shouldFlushPending(
  stats: PendingJournalStats,
  now: number,
  thresholdMs: number = OPPORTUNISTIC_FLUSH_AFTER_MS,
): boolean {
  if (stats.sampled) {
    return true;
  }
  return (
    stats.pendingCount > 0 &&
    (stats.oldestPendingAt === undefined || now - stats.oldestPendingAt > thresholdMs)
  );
}

export async function flushIfNeeded(): Promise<void> {
  try {
    const stats = pendingJournalStats();
    // capturedAt measures how long a Move has actually waited. Journal mtime
    // measures only the latest append and can postpone a continuously-written
    // queue forever. Missing timestamps are flushed defensively rather than
    // stranded.
    if (shouldFlushPending(stats, Date.now())) {
      await flush();
    }
  } catch {
    // Opportunistic flush must never break a CLI command.
  }
}
