/**
 * Decision Event Pipeline — flusher.
 *
 * Drains each per-bucket journal to /api/cli/moves/ingest using rotate-
 * then-process so moves appended during the flush window are never lost:
 *
 *   1. Atomically rename <bucket>/journal.ndjson → .flushing.<ts>.<pid>.
 *      Concurrent hook appends start a fresh journal.ndjson; a concurrent
 *      drain that loses the rename race is a no-op (ENOENT).
 *   2. POST batches of up to 500 moves to /api/cli/moves/ingest.
 *   3. On success, unlink the .flushing file.
 *
 * flush() first re-drains any stranded .flushing files — orphaned when a
 * drain died between the rename and the unlink — then enumerates and drains
 * the live bucket journals. An orphan is adopted only once its owning drain is
 * provably gone (a dead pid, or an aged legacy pid-less file), so a concurrent
 * drain's in-flight file is never stolen out from under it. On a POST failure
 * the .flushing file is left behind for the next sweep, so no moves are lost
 * on a clean failure. Uses getClient() for bearer auth + auto-refresh.
 */

import { createReadStream, renameSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { type CliClient, HttpError, getClient } from "./client.js";
import { type DeadLetterReason, quarantineMove } from "./dead-letter.js";
import { requireDurableIngestAcknowledgement } from "./ingest-response.js";
import {
  type FlushingFile,
  JOURNAL_DIR,
  type PendingJournalStats,
  listBuckets,
  listFlushing,
  pendingJournalStats,
} from "./journal.js";
import { withFileLock } from "./lib/file-lock.js";
import type { Move } from "./protocol/move.js";

const BATCH_SIZE = 500;
const HTTP_TIMEOUT_MS = 10_000;
const OPPORTUNISTIC_FLUSH_AFTER_MS = 60_000;
// A stranded .flushing file is adopted once its owning drain is provably gone.
// A live drain stamps its pid into the filename, so a dead pid is the common
// crash signal; the legacy pid-less variant carries no owner, so it is adopted
// only after aging past this window — long enough that a live in-flight drain
// (bounded by HTTP_TIMEOUT_MS) is never mistaken for an orphan.
const ORPHAN_QUARANTINE_MS = 60_000;

/**
 * Slice a move list into fixed-size POST batches, preserving order and
 * identity. Pure, so the batching the drain — and the recovery re-drain that
 * replays a stranded `.flushing` file — both rely on can be pinned without a
 * network round-trip. Re-POSTing the same moveIds is safe because the server
 * dedups ingest at by_move_id.
 */
export function batchMoves(moves: Move[], size: number = BATCH_SIZE): Move[][] {
  const batches: Move[][] = [];
  for (let i = 0; i < moves.length; i += size) {
    batches.push(moves.slice(i, i + size));
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

function deadLetterReason(error: unknown): DeadLetterReason | undefined {
  if (!(error instanceof HttpError)) {
    return undefined;
  }
  if (error.status === 400) {
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
 * Drain an already-rotated `.flushing` file: POST its moves in batches, then
 * unlink on success. On a POST failure it throws WITHOUT unlinking, so the
 * file stays on disk for the next sweep — no moves are lost on a clean
 * failure. Shared by the normal rotate path and orphan recovery.
 */
export async function drainFlushingPath(
  flushingPath: string,
  client: CliClient = getClient(),
): Promise<DrainCounts> {
  const postBatch = async (batch: Move[]): Promise<DrainCounts> => {
    try {
      const response = await client.post(
        "/api/cli/moves/ingest",
        { batch },
        { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
      );
      requireDurableIngestAcknowledgement(response, batch.length);
      return { flushed: batch.length, quarantined: 0 };
    } catch (error) {
      const reason = deadLetterReason(error);
      if (!reason) {
        throw error;
      }
      if (batch.length > 1) {
        // Ingest rejects a batch atomically. Bisect only deterministic 4xx
        // failures so valid neighbors can be durably acknowledged while the
        // exact offending envelope is isolated locally.
        const midpoint = Math.floor(batch.length / 2);
        const left = await postBatch(batch.slice(0, midpoint));
        const right = await postBatch(batch.slice(midpoint));
        return addDrainCounts(left, right);
      }
      const [move] = batch;
      const quarantined = quarantineMove(flushingPath, move, reason);
      process.stderr.write(
        `[prim] quarantined rejected move ${quarantined.quarantineId.slice(0, 12)} (${reason})\n`,
      );
      return { flushed: 0, quarantined: 1 };
    }
  };

  const input = createReadStream(flushingPath, { encoding: "utf-8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let batch: Move[] = [];
  let counts: DrainCounts = { flushed: 0, quarantined: 0 };
  try {
    for await (const line of lines) {
      if (line.length === 0) {
        continue;
      }
      try {
        batch.push(JSON.parse(line) as Move);
      } catch {
        // Preserve the journal's established malformed-line behavior: invalid
        // records are skipped rather than blocking every valid Move behind it.
        continue;
      }
      if (batch.length === BATCH_SIZE) {
        counts = addDrainCounts(counts, await postBatch(batch));
        batch = [];
      }
    }
    if (batch.length > 0) {
      counts = addDrainCounts(counts, await postBatch(batch));
    }
  } finally {
    lines.close();
    input.destroy();
  }
  unlinkSync(flushingPath);
  return counts;
}

async function drainPath(path: string): Promise<DrainCounts> {
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

  return drainFlushingPath(tmpPath);
}

export function processIsAlive(
  pid: number,
  probe: (pid: number, signal: 0) => true = process.kill,
): boolean {
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    // EPERM proves the process exists even though this user cannot signal it.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
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
 * rename and the unlink. Each recoverable file is re-POSTed under its original
 * moveIds (the server dedups at by_move_id, so a file delivered before the
 * crash replays harmlessly), then unlinked. A file whose POST fails is left
 * for the next sweep rather than aborting recovery of the rest.
 */
export type DrainSummary = DrainCounts & { errors: unknown[]; failedBuckets: Set<string> };

export async function recoverOrphans(
  candidates: FlushingFile[] = listFlushing({ sampleBytes: 0 }),
  options: {
    now?: number;
    ownerPid?: number;
    isAlive?: (pid: number) => boolean;
    drain?: (path: string) => Promise<DrainCounts>;
  } = {},
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
  const drain = options.drain ?? drainFlushingPath;
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

async function flushOnce(): Promise<DrainCounts> {
  // Reclaim crash-stranded orphans first, then drain the live buckets.
  // Path-only enumeration (listBuckets does not stat/read), so the only
  // race-sensitive op is drainPath's ENOENT-tolerant rename.
  const recovered = await recoverOrphans();
  let total = recovered.flushed;
  let quarantined = recovered.quarantined;
  const errors = recovered.errors;
  for (const { bucket, path } of listBuckets()) {
    // Do not create one new failed rotation per retry while a prior rotation
    // for this bucket is still undeliverable (for example, capture disabled).
    // Other buckets remain independent and continue draining.
    if (recovered.failedBuckets.has(bucket)) {
      continue;
    }
    try {
      const counts = await drainPath(path);
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
  return { flushed: total, quarantined };
}

// `skipped` distinguishes a contended bow-out (another process holds the drain
// lock) from a genuine empty-journal drain, so the daemon does not record a
// false success and `prim moves flush` does not imply the journal was empty.
export type FlushResult = DrainCounts & { skipped?: boolean };

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
