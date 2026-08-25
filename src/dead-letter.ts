/** Durable local disposition for Move envelopes the ingest API will never accept. */

import { createHash, randomBytes } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { syncDirectory } from "./lib/atomic-file.js";
import type { Move } from "./protocol/move.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
export const DEAD_LETTER_DIRNAME = "dead-letter";

export type DeadLetterReason = "invalid_move" | "move_id_conflict" | "tenant_mismatch";

export type DeadLetterRecord = {
  version: 1;
  quarantineId: string;
  quarantinedAt: number;
  reason: DeadLetterReason;
  move: Move;
};

export function deadLetterDirectoryForRotation(flushingPath: string): string {
  return join(dirname(flushingPath), DEAD_LETTER_DIRNAME);
}

export function deadLetterPathForMove(flushingPath: string, move: Move): string {
  const serializedMove = JSON.stringify(move);
  const quarantineId = createHash("sha256").update(serializedMove).digest("hex");
  return join(deadLetterDirectoryForRotation(flushingPath), `${quarantineId}.json`);
}

/**
 * Persist one rejected envelope before its source rotation can be retired.
 *
 * Reasons are a closed local vocabulary: server response prose is never
 * copied into this secret-bearing file or a terminal. One atomically-renamed
 * file per envelope makes replay idempotent: a crash after quarantine but
 * before source unlink cannot grow an unbounded duplicate log. The source
 * `.flushing` file remains in place whenever this write or fsync fails,
 * preserving the WAL's no-loss boundary.
 */
export function quarantineMove(
  flushingPath: string,
  move: Move,
  reason: DeadLetterReason,
  now: () => number = Date.now,
): DeadLetterRecord {
  const directory = deadLetterDirectoryForRotation(flushingPath);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(directory, DIRECTORY_MODE);
  syncDirectory(dirname(directory));

  const serializedMove = JSON.stringify(move);
  const record: DeadLetterRecord = {
    version: 1,
    quarantineId: createHash("sha256").update(serializedMove).digest("hex"),
    quarantinedAt: now(),
    reason,
    move,
  };
  const path = join(directory, `${record.quarantineId}.json`);
  if (existsSync(path)) {
    syncDirectory(directory);
    return record;
  }

  const temporaryPath = join(
    directory,
    `.${record.quarantineId}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  const fd = openSync(temporaryPath, flags, FILE_MODE);
  try {
    fchmodSync(fd, FILE_MODE);
    writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    // Same-directory rename is atomic. If another flusher won the race, its
    // complete record is equivalent and this complete file may replace it.
    renameSync(temporaryPath, path);
    syncDirectory(directory);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
  return record;
}
