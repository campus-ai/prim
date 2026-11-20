/** Private, bounded handoff files. Never print config bodies or credential material. */
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  unlinkSync,
} from "node:fs";
import { dirname, isAbsolute, normalize } from "node:path";
import { promisify } from "node:util";
import { parseDocument, visit } from "yaml";
import { atomicWriteFile, syncDirectory } from "./atomic-file.js";

export const run = promisify(execFile);
export const MAX_FILE = 4 * 1024 * 1024;
export type Image = { hash: string | null; mode: number; text: string | null };
export function digest(text: string | Buffer): string {
  return createHash("sha256").update(text).digest("hex");
}
export function pathSafe(path: string): string {
  if (!isAbsolute(path) || normalize(path) !== path || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(path))
    throw new Error("Handoff paths must be normalized absolute paths without control characters");
  for (let current = path; ; current = dirname(current)) {
    try {
      if (lstatSync(current).isSymbolicLink())
        throw new Error("Handoff paths cannot contain symlinks");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    if (current === dirname(current)) break;
  }
  return path;
}
export function readOwned(
  path: string,
  limit = MAX_FILE,
  allowRootOwned = false,
): { bytes: Buffer; mode: number } | null {
  pathSafe(path);
  let linked: ReturnType<typeof lstatSync>;
  try {
    linked = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (
      !stat.isFile() ||
      stat.dev !== linked.dev ||
      stat.ino !== linked.ino ||
      stat.nlink !== 1 ||
      stat.size > limit ||
      (process.getuid &&
        stat.uid !== process.getuid() &&
        !(allowRootOwned && stat.uid === 0 && (stat.mode & 0o022) === 0))
    )
      throw new Error(
        `Handoff requires owned, bounded, singly-linked regular files: ${path} (regular=${stat.isFile()}, owner=${stat.uid}, links=${stat.nlink}, bytes=${stat.size})`,
      );
    const bytes = Buffer.allocUnsafe(stat.size + 1);
    let length = 0;
    while (length < bytes.length) {
      const count = readSync(fd, bytes, length, bytes.length - length, length);
      if (!count) break;
      length += count;
    }
    const after = fstatSync(fd);
    if (
      length !== stat.size ||
      after.size !== stat.size ||
      after.mtimeMs !== stat.mtimeMs ||
      after.mode !== stat.mode
    )
      throw new Error("Handoff file changed while reading");
    return { bytes: bytes.subarray(0, length), mode: stat.mode & 0o777 };
  } finally {
    closeSync(fd);
  }
}
export function image(path: string, allowRootOwned = false): Image {
  const read = readOwned(path, MAX_FILE, allowRootOwned);
  if (!read) return { text: null, hash: null, mode: 0o600 };
  const text = read.bytes.toString("utf8");
  if (!Buffer.from(text).equals(read.bytes)) throw new Error("Handoff config must be UTF-8");
  return { text, hash: digest(read.bytes), mode: read.mode };
}
export function guardImage(path: string): Image {
  return image(path, true);
}
export function boundedNames(path: string, limit: number): string[] {
  const dir = opendirSync(path);
  const names: string[] = [];
  try {
    for (;;) {
      const entry = dir.readSync();
      if (!entry) return names;
      if (names.length >= limit) throw new Error("Directory inventory exceeds its bound");
      names.push(entry.name);
    }
  } finally {
    dir.closeSync();
  }
}
export function privateDirectory(path: string): void {
  pathSafe(path);
  const stat = lstatSync(path);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o077) !== 0 ||
    (process.getuid && stat.uid !== process.getuid())
  )
    throw new Error("Transaction directory must be owned and private (0700)");
}
export function privateJSON(path: string): unknown {
  const value = image(path);
  if (value.text === null || (value.mode & 0o077) !== 0)
    throw new Error("Transaction files must be private (0600)");
  return json(value.text);
}
export function json(text: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error("Malformed JSON; config contents were withheld");
  }
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Duplicate or malformed JSON keys");
  return parsed;
}
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected an object");
  return value as Record<string, unknown>;
}
export function equal(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b))
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((v, i) => equal(v, b[i]))
    );
  const left = object(a);
  const right = object(b);
  return (
    Object.keys(left).length === Object.keys(right).length &&
    Object.keys(left).every((key) => Object.hasOwn(right, key) && equal(left[key], right[key]))
  );
}
export function yaml(text: string) {
  const doc = parseDocument(text, { uniqueKeys: true });
  if (doc.errors.length) throw new Error("Malformed or duplicate YAML keys");
  visit(doc, {
    Alias() {
      throw new Error("YAML aliases are not supported during handoff");
    },
    Node(_key, node) {
      if ("anchor" in node && node.anchor)
        throw new Error("YAML anchors are not supported during handoff");
    },
  });
  object(doc.toJS({ maxAliasCount: 0 }) ?? {});
  return doc;
}
export function writePrivate(path: string, value: unknown): void {
  pathSafe(path);
  const text = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(text) > MAX_FILE)
    throw new Error("Private transaction record exceeds its read bound");
  atomicWriteFile(path, text, { mode: 0o600 });
}
export function writeImage(path: string, value: Image): void {
  pathSafe(path);
  if (value.text === null) {
    if (image(path).text !== null) {
      unlinkSync(path);
      syncDirectory(dirname(path));
    }
  } else atomicWriteFile(path, value.text, { mode: value.mode });
}
export function canonicalDirectory(path: string): string {
  pathSafe(path);
  if (!lstatSync(path).isDirectory() || realpathSync(path) !== path)
    throw new Error("Directory must be canonical and already exist");
  return path;
}
