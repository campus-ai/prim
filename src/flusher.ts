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

import { renameSync, unlinkSync } from "node:fs";
import { getClient } from "./client.js";
import {
  type FlushingFile,
  bucketStats,
  listBuckets,
  listFlushing,
  readMovesFromPath,
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
async function drainFlushingPath(flushingPath: string): Promise<number> {
  const moves = readMovesFromPath(flushingPath);
  if (moves.length === 0) {
    unlinkSync(flushingPath);
    return 0;
  }

  const client = getClient();
  for (const batch of batchMoves(moves)) {
    await client.post(
      "/api/cli/moves/ingest",
      { batch },
      { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    );
  }
  unlinkSync(flushingPath);
  return moves.length;
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
  opts: { quarantineMs?: number; isAlive?: (pid: number) => boolean } = {},
): FlushingFile[] {
  const quarantineMs = opts.quarantineMs ?? ORPHAN_QUARANTINE_MS;
  const isAlive = opts.isAlive ?? processIsAlive;
  return files.filter((f) =>
    f.pid === undefined ? now - f.mtimeMs > quarantineMs : !isAlive(f.pid),
  );
}

/**
 * Re-drain stranded `.flushing` files left by a drain that died between the
 * rename and the unlink. Each recoverable file is re-POSTed under its original
 * moveIds (the server dedups at by_move_id, so a file delivered before the
 * crash replays harmlessly), then unlinked. A file whose POST fails is left
 * for the next sweep rather than aborting recovery of the rest.
 */
async function recoverOrphans(): Promise<number> {
  let total = 0;
  for (const file of selectRecoverable(listFlushing(), Date.now())) {
    try {
      total += await drainFlushingPath(file.path);
    } catch {
      // Leave this orphan on disk for a later sweep; keep recovering the rest.
    }
  }
  return total;
}

export async function flush(): Promise<{ flushed: number }> {
  // Reclaim crash-stranded orphans first, then drain the live buckets.
  // Path-only enumeration (listBuckets does not stat/read), so the only
  // race-sensitive op is drainPath's ENOENT-tolerant rename.
  let total = await recoverOrphans();
  for (const { path } of listBuckets()) {
    total += await drainPath(path);
  }
  return { flushed: total };
}

export async function flushIfNeeded(): Promise<void> {
  try {
    const stats = bucketStats();
    if (stats.length === 0) {
      return;
    }
    const oldest = stats.reduce((min, s) => (s.mtimeMs < min ? s.mtimeMs : min), stats[0].mtimeMs);
    if (Date.now() - oldest > OPPORTUNISTIC_FLUSH_AFTER_MS) {
      await flush();
    }
  } catch {
    // Opportunistic flush must never break a CLI command.
  }
}
