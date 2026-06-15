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
 * flush() enumerates bucket paths WITHOUT reading their contents, so the
 * atomic rename in drainPath is the only race-sensitive op — a concurrent
 * drain can never crash the explicit `prim moves flush`. On failure the
 * .flushing file is left behind for inspection; recovering stranded
 * .flushing files on a later drain is future work. Uses getClient() for
 * bearer auth + auto-refresh.
 */

import { renameSync, unlinkSync } from "node:fs";
import { getClient } from "./client.js";
import { bucketStats, listBuckets, readMovesFromPath } from "./journal.js";

const BATCH_SIZE = 500;
const HTTP_TIMEOUT_MS = 10_000;
const OPPORTUNISTIC_FLUSH_AFTER_MS = 60_000;

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

  const moves = readMovesFromPath(tmpPath);
  if (moves.length === 0) {
    unlinkSync(tmpPath);
    return 0;
  }

  const client = getClient();
  for (let i = 0; i < moves.length; i += BATCH_SIZE) {
    const batch = moves.slice(i, i + BATCH_SIZE);
    await client.post(
      "/api/cli/moves/ingest",
      { batch },
      { signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) },
    );
  }
  unlinkSync(tmpPath);
  return moves.length;
}

export async function flush(): Promise<{ flushed: number }> {
  let total = 0;
  // Path-only enumeration (listBuckets does not stat/read), so the only
  // race-sensitive op is drainPath's ENOENT-tolerant rename.
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
