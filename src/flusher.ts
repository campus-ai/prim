/**
 * Decision Event Pipeline — flusher.
 *
 * Drains the local journal to /api/cli/moves/ingest using rotate-then-
 * process so moves appended during the flush window are never lost:
 *
 *   1. Atomically rename journal.ndjson → journal.flushing.<ts>.<pid>.
 *      Concurrent hook appends start a fresh journal.ndjson; a concurrent
 *      drain that loses the rename race is a no-op (ENOENT).
 *   2. POST batches of up to 500 moves to /api/cli/moves/ingest.
 *   3. On success, unlink the .flushing file.
 *
 * On failure the .flushing file is left behind for inspection; recovering
 * stranded .flushing files on a later drain is future work. Uses
 * getClient() for bearer auth + auto-refresh.
 */

import { renameSync, unlinkSync } from "node:fs";
import { getClient } from "./client.js";
import { JOURNAL_PATH, journalStats, readMovesFromPath } from "./journal.js";

const BATCH_SIZE = 500;
const HTTP_TIMEOUT_MS = 10_000;
const OPPORTUNISTIC_FLUSH_AFTER_MS = 60_000;

export async function flush(): Promise<{ flushed: number }> {
  const tmpPath = `${JOURNAL_PATH}.flushing.${String(Date.now())}.${String(process.pid)}`;
  try {
    renameSync(JOURNAL_PATH, tmpPath);
  } catch (err) {
    // No journal to drain, or a concurrent drain already rotated it.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { flushed: 0 };
    }
    throw err;
  }

  const moves = readMovesFromPath(tmpPath);
  if (moves.length === 0) {
    unlinkSync(tmpPath);
    return { flushed: 0 };
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
  return { flushed: moves.length };
}

export async function flushIfNeeded(): Promise<void> {
  try {
    const stats = journalStats();
    if (!stats) {
      return;
    }
    if (Date.now() - stats.mtimeMs > OPPORTUNISTIC_FLUSH_AFTER_MS) {
      await flush();
    }
  } catch {
    // Opportunistic flush must never break a CLI command.
  }
}
