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

/** Flush directory entries created by a rename or recursive mkdir. */
export function syncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Persist every directory entry made by recursive mkdir before a subsequent
 * atomic rename relies on the new leaf directory.
 */
function syncCreatedParentChain(firstCreatedParent: string, parent: string): void {
  const createdDirectories: string[] = [];
  let current = parent;
  while (current !== firstCreatedParent) {
    createdDirectories.push(current);
    const next = dirname(current);
    if (next === current) {
      throw new Error("recursive mkdir returned a path outside the target parent chain");
    }
    current = next;
  }
  createdDirectories.push(firstCreatedParent);

  // The first newly-created directory is linked from this pre-existing parent.
  syncDirectory(dirname(firstCreatedParent));
  // Each following created directory is linked from its predecessor. The final
  // target parent is flushed after the file rename below, along with that entry.
  for (const directory of createdDirectories.reverse().slice(0, -1)) {
    syncDirectory(directory);
  }
}

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
  const parent = dirname(target);
  let firstCreatedParent: string | undefined;
  if (options.ensureParent) {
    firstCreatedParent = mkdirSync(parent, { recursive: true });
    if (firstCreatedParent) {
      syncCreatedParentChain(firstCreatedParent, parent);
    }
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
    syncDirectory(parent);
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
