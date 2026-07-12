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
import { createInterface } from "node:readline";
import { type CliClient, getClient } from "./client.js";
import { requireDurableIngestAcknowledgement } from "./ingest-response.js";
import {
  type FlushingFile,
  type PendingJournalStats,
  listBuckets,
  listFlushing,
  pendingJournalStats,
} from "./journal.js";
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

/**
 * Drain an already-rotated `.flushing` file: POST its moves in batches, then
 * unlink on success. On a POST failure it throws WITHOUT unlinking, so the
 * file stays on disk for the next sweep — no moves are lost on a clean
 * failure. Shared by the normal rotate path and orphan recovery.
 */
export async function drainFlushingPath(
  flushingPath: string,
  client: CliClient = getClient(),
): Promise<number> {
  const postBatch = async (batch: Move[]): Promise<void> => {
    const response = await client.post(
      "/api/cli/moves/ingest",
      { batch },
      { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    );
    requireDurableIngestAcknowledgement(response, batch.length);
  };

  const input = createReadStream(flushingPath, { encoding: "utf-8" });
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  let batch: Move[] = [];
  let total = 0;
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
        await postBatch(batch);
        total += batch.length;
        batch = [];
      }
    }
    if (batch.length > 0) {
      await postBatch(batch);
      total += batch.length;
    }
  } finally {
    lines.close();
    input.destroy();
  }
  unlinkSync(flushingPath);
  return total;
}

async function drainPath(path: string): Promise<number> {
  const tmpPath = `${path}.flushing.${String(Date.now())}.${String(process.pid)}`;
  try {
    renameSync(path, tmpPath);
  } catch (err) {
    // No journal at this path, or a concurrent drain already rotated it.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return 0;
    }
    throw err;
  }

  return drainFlushingPath(tmpPath);
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
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
export type DrainSummary = { flushed: number; errors: unknown[]; failedBuckets: Set<string> };

export async function recoverOrphans(
  candidates: FlushingFile[] = listFlushing({ sampleBytes: 0 }),
  options: {
    now?: number;
    ownerPid?: number;
    isAlive?: (pid: number) => boolean;
    drain?: (path: string) => Promise<number>;
  } = {},
): Promise<DrainSummary> {
  const summary: DrainSummary = { flushed: 0, errors: [], failedBuckets: new Set() };
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
      summary.flushed += await drain(file.path);
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

  constructor(cause: unknown, flushed: number) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "FlushError";
    this.flushed = flushed;
  }
}

async function flushOnce(): Promise<{ flushed: number }> {
  // Reclaim crash-stranded orphans first, then drain the live buckets.
  // Path-only enumeration (listBuckets does not stat/read), so the only
  // race-sensitive op is drainPath's ENOENT-tolerant rename.
  const recovered = await recoverOrphans();
  let total = recovered.flushed;
  const errors = recovered.errors;
  for (const { bucket, path } of listBuckets()) {
    // Do not create one new failed rotation per retry while a prior rotation
    // for this bucket is still undeliverable (for example, capture disabled).
    // Other buckets remain independent and continue draining.
    if (recovered.failedBuckets.has(bucket)) {
      continue;
    }
    try {
      total += await drainPath(path);
    } catch (err) {
      // One broken/disabled bucket must not prevent independent buckets from
      // draining. Every failed rotation remains on disk for the next attempt.
      errors.push(err);
    }
  }
  if (errors.length > 0) {
    throw new FlushError(errors[0], total);
  }
  return { flushed: total };
}

let flushInFlight: Promise<{ flushed: number }> | undefined;

/** Serialize drains in this process so rotations are never self-stolen. */
export function flush(): Promise<{ flushed: number }> {
  if (flushInFlight) {
    return flushInFlight;
  }
  const attempt = flushOnce().finally(() => {
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
