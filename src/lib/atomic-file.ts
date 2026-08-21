import { randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  fchmodSync,
  fsyncSync,
  mkdirSync,
  openSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";

export type AtomicFileOptions = {
  /** Exact mode applied to the temporary file before content is written. */
  mode?: number;
  /** Create a missing parent directory before writing. */
  ensureParent?: boolean;
  /** Validate the fully flushed temporary file before it replaces the target. */
  validate?: (temporaryPath: string) => void;
};

const DEFAULT_FILE_MODE = 0o666;

/**
 * Replace one file with fully flushed bytes without ever following a temporary
 * path planted by another process. The temporary lives beside the target, so
 * the final rename is atomic on the target filesystem.
 */
export function atomicWriteFile(
  target: string,
  content: string,
  options: AtomicFileOptions = {},
): void {
  if (options.ensureParent) {
    mkdirSync(dirname(target), { recursive: true });
  }

  const temporaryPath = `${target}.${randomUUID()}.tmp`;
  let temporaryCreated = false;
  try {
    const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;
    const fd = openSync(temporaryPath, flags, options.mode ?? DEFAULT_FILE_MODE);
    temporaryCreated = true;
    try {
      if (options.mode !== undefined) fchmodSync(fd, options.mode);
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    options.validate?.(temporaryPath);
    renameSync(temporaryPath, target);
  } catch (error) {
    if (temporaryCreated) {
      try {
        rmSync(temporaryPath, { force: true });
      } catch {
        // Preserve the write failure; cleanup is best-effort.
      }
    }
    throw error;
  }
}
