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

/**
 * A journal line that could not be decoded and parsed into any JSON value.
 *
 * Keep the exact bytes rather than fabricating a Move. Base64 makes the
 * record valid JSON even when the journal line contains invalid UTF-8, while
 * the digest provides the same crash/replay idempotency as Move quarantine.
 */
export type RawLineDeadLetterRecord = {
  version: 1;
  recordKind: "raw_line_v1";
  quarantineId: string;
  quarantinedAt: number;
  reason: "invalid_move";
  rawLineEncoding: "base64";
  rawLineBytes: number;
  rawLine: string;
};

export type AnyDeadLetterRecord = DeadLetterRecord | RawLineDeadLetterRecord;

export type DeadLetterPersistenceOptions = {
  /** Test seam for directory-metadata durability failures. */
  syncDirectory?: (path: string) => void;
};

export function deadLetterDirectoryForRotation(flushingPath: string): string {
  return join(dirname(flushingPath), DEAD_LETTER_DIRNAME);
}

export function deadLetterPathForMove(flushingPath: string, move: Move): string {
  const serializedMove = JSON.stringify(move);
  const quarantineId = createHash("sha256").update(serializedMove).digest("hex");
  return join(deadLetterDirectoryForRotation(flushingPath), `${quarantineId}.json`);
}

export function deadLetterPathForRawLine(flushingPath: string, rawLine: Uint8Array): string {
  const quarantineId = createHash("sha256").update(rawLine).digest("hex");
  return join(deadLetterDirectoryForRotation(flushingPath), `raw-${quarantineId}.json`);
}

function fsyncDirectory(path: string): void {
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const fd = openSync(path, flags);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function ensureDeadLetterDirectory(
  flushingPath: string,
  syncDirectory: (path: string) => void,
): string {
  const directory = deadLetterDirectoryForRotation(flushingPath);
  mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(directory, DIRECTORY_MODE);
  // The dead-letter directory itself is new on the first quarantine. Persist
  // that parent-directory entry before any source rotation can be retired.
  syncDirectory(dirname(directory));
  return directory;
}

function persistDeadLetter(
  directory: string,
  path: string,
  quarantineId: string,
  record: AnyDeadLetterRecord,
  syncDirectory: (path: string) => void,
): void {
  if (existsSync(path)) {
    // A previous attempt may have renamed the complete record and then failed
    // its directory fsync. Re-establish that durability before returning an
    // idempotent success that permits source unlink.
    syncDirectory(directory);
    return;
  }

  const temporaryPath = join(
    directory,
    `.${quarantineId}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`,
  );
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  try {
    const fd = openSync(temporaryPath, flags, FILE_MODE);
    try {
      fchmodSync(fd, FILE_MODE);
      writeFileSync(fd, `${JSON.stringify(record)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    // Same-directory rename is atomic. If another flusher won the race, its
    // complete record is equivalent and this complete file may replace it.
    renameSync(temporaryPath, path);
    syncDirectory(directory);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
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
  options: DeadLetterPersistenceOptions = {},
): DeadLetterRecord {
  const syncDirectory = options.syncDirectory ?? fsyncDirectory;
  const directory = ensureDeadLetterDirectory(flushingPath, syncDirectory);

  const serializedMove = JSON.stringify(move);
  const record: DeadLetterRecord = {
    version: 1,
    quarantineId: createHash("sha256").update(serializedMove).digest("hex"),
    quarantinedAt: now(),
    reason,
    move,
  };
  const path = join(directory, `${record.quarantineId}.json`);
  persistDeadLetter(directory, path, record.quarantineId, record, syncDirectory);
  return record;
}

/**
 * Durably quarantine one syntax-invalid NDJSON line before its source
 * rotation can be retired. The exact bytes are secret-bearing and therefore
 * stay only in the hardened dead-letter file; terminals receive the digest.
 */
export function quarantineRawLine(
  flushingPath: string,
  rawLine: Uint8Array,
  now: () => number = Date.now,
  options: DeadLetterPersistenceOptions = {},
): RawLineDeadLetterRecord {
  const syncDirectory = options.syncDirectory ?? fsyncDirectory;
  const directory = ensureDeadLetterDirectory(flushingPath, syncDirectory);

  const bytes = Buffer.from(rawLine);
  const record: RawLineDeadLetterRecord = {
    version: 1,
    recordKind: "raw_line_v1",
    quarantineId: createHash("sha256").update(bytes).digest("hex"),
    quarantinedAt: now(),
    reason: "invalid_move",
    rawLineEncoding: "base64",
    rawLineBytes: bytes.length,
    rawLine: bytes.toString("base64"),
  };
  persistDeadLetter(
    directory,
    deadLetterPathForRawLine(flushingPath, bytes),
    record.quarantineId,
    record,
    syncDirectory,
  );
  return record;
}
