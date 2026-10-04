import { constants, closeSync, fstatSync, lstatSync, openSync, readSync } from "node:fs";

export type BoundedFile = { text: string; ownerUid: number };

/**
 * Read a small regular file without following a symlink or blocking on a FIFO
 * or device node. lstat must report a regular file within `maxBytes`, the open
 * uses O_NOFOLLOW | O_NONBLOCK (so a FIFO swapped in afterwards cannot make it
 * wait for a writer), and the opened descriptor must be that same file.
 * Anything else, including a file that grows past the bound, reads as absent.
 */
export function readBoundedRegularFile(path: string, maxBytes: number): BoundedFile | undefined {
  let fd: number | undefined;
  try {
    const linked = lstatSync(path);
    if (!linked.isFile() || linked.size > maxBytes) return undefined;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const opened = fstatSync(fd);
    if (
      !opened.isFile() ||
      opened.dev !== linked.dev ||
      opened.ino !== linked.ino ||
      opened.size > maxBytes
    ) {
      return undefined;
    }
    // One spare byte detects growth after fstat instead of truncating silently.
    const buffer = Buffer.allocUnsafe(opened.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > opened.size) return undefined;
    return { text: buffer.subarray(0, length).toString("utf8"), ownerUid: opened.uid };
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // A failed close leaks only this descriptor; the read result stands.
      }
    }
  }
}
