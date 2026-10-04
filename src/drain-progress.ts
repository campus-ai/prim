/**
 * Decision Event Pipeline — drain checkpoints.
 *
 * Ingest commits every batch independently, and it can commit a batch after
 * the client has already timed out on it. A drain that retired its rotation
 * only once every batch succeeded therefore restarted at line 1 after each
 * failure, re-POSTing every batch the server already held. Each deduped
 * replay still cost a full upload and server pass, so a slow backlog's
 * traffic grew quadratically while its oldest pending move never changed. A
 * checkpoint records the byte offset of the first line not yet durably
 * acknowledged or quarantined, so the next drain resumes there.
 *
 * The checkpoint is advisory. It only ever advances past work that is already
 * durable elsewhere, so a lost write, or a checkpoint ignored because it does
 * not provably describe the rotation, costs a deduped replay and never skips
 * an undelivered move. It lives in `<bucket>/drain-progress/`, beside
 * `dead-letter/`, because every bucket-level file named
 * `journal.ndjson.flushing.*` is enumerated as a rotation.
 */

import { randomBytes } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { syncDirectory } from "./lib/atomic-file.js";

const DIRECTORY_MODE = 0o700;
const FILE_MODE = 0o600;
export const DRAIN_PROGRESS_DIRNAME = "drain-progress";
// `<rotation>.json`, or an interrupted write's `<rotation>.json.<pid>.<hex>.tmp`.
const CHECKPOINT_NAME = /^(.+)\.json(?:\.[0-9]+\.[0-9a-f]+\.tmp)?$/;

export type DrainCheckpoint = {
  v: 1;
  /** Byte offset of the first line not yet durably acknowledged or quarantined. */
  offset: number;
  /** The rotation's size when drained; a rotation is never appended to. */
  size: number;
};

export function drainProgressDirectory(flushingPath: string): string {
  return join(dirname(flushingPath), DRAIN_PROGRESS_DIRNAME);
}

export function drainProgressPath(flushingPath: string): string {
  return join(drainProgressDirectory(flushingPath), `${basename(flushingPath)}.json`);
}

function isByteCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Where a drain, or a pending-stats sample, of this rotation begins: the
 * checkpointed offset only when it provably describes the rotation's current
 * bytes, otherwise 0. A missing, unreadable, corrupt, or foreign checkpoint is
 * never an error — starting over replays moves the server dedups by moveId.
 */
export function drainResumeOffset(flushingPath: string, sizeBytes: number): number {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(drainProgressPath(flushingPath), "utf8"));
  } catch {
    return 0;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return 0;
  }
  const { v, offset, size } = parsed as Record<string, unknown>;
  // Any size change means the checkpoint describes other bytes than the ones
  // on disk now, so none of its progress can be trusted.
  if (v !== 1 || size !== sizeBytes || !isByteCount(offset) || offset > sizeBytes) {
    return 0;
  }
  return offset;
}

/**
 * Atomically replace a rotation's checkpoint. Readers see either the previous
 * checkpoint or this complete one, and callers advance it only past lines that
 * are already durable, so a write lost to a crash rewinds to a safe replay.
 */
export function writeDrainCheckpoint(flushingPath: string, checkpoint: DrainCheckpoint): void {
  const directory = drainProgressDirectory(flushingPath);
  if (mkdirSync(directory, { recursive: true, mode: DIRECTORY_MODE }) !== undefined) {
    syncDirectory(dirname(directory));
  }
  chmodSync(directory, DIRECTORY_MODE);

  const path = drainProgressPath(flushingPath);
  const temporaryPath = `${path}.${String(process.pid)}.${randomBytes(8).toString("hex")}.tmp`;
  const flags = constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW;
  try {
    const fd = openSync(temporaryPath, flags, FILE_MODE);
    try {
      fchmodSync(fd, FILE_MODE);
      writeFileSync(fd, `${JSON.stringify(checkpoint)}\n`, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temporaryPath, path);
    syncDirectory(directory);
  } finally {
    rmSync(temporaryPath, { force: true });
  }
}

/**
 * Remove the checkpoint directory once nothing is left in it, so a drained
 * bucket carries no drain residue. Another rotation's checkpoint keeps it.
 */
function removeEmptyDirectory(directory: string): void {
  try {
    rmdirSync(directory);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTEMPTY" && code !== "EEXIST") {
      throw error;
    }
  }
}

/** Retire a checkpoint after its rotation is unlinked; absence is success. */
export function removeDrainCheckpoint(flushingPath: string): void {
  rmSync(drainProgressPath(flushingPath), { force: true });
  removeEmptyDirectory(drainProgressDirectory(flushingPath));
}

/**
 * Drop checkpoints, and interrupted checkpoint writes, whose rotation is gone:
 * a drain that died between unlinking a finished rotation and its checkpoint.
 * A checkpoint whose rotation still exists is live and left alone. Cleanup is
 * best-effort; anything left behind is retried on the next sweep.
 */
export function sweepOrphanedDrainCheckpoints(bucketDirectory: string): void {
  const directory = join(bucketDirectory, DRAIN_PROGRESS_DIRNAME);
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    // Usually ENOENT: no drain in this bucket holds a checkpoint.
    return;
  }
  for (const name of names) {
    const rotation = CHECKPOINT_NAME.exec(name)?.[1];
    if (rotation === undefined || existsSync(join(bucketDirectory, rotation))) {
      continue;
    }
    try {
      rmSync(join(directory, name), { force: true });
    } catch {
      // Best-effort; the next sweep retries.
    }
  }
  try {
    removeEmptyDirectory(directory);
  } catch {
    // Best-effort; the next sweep retries.
  }
}
