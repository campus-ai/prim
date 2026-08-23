/**
 * Decision Event Pipeline — local NDJSON journal.
 *
 * Moves are journaled under a per-ENVIRONMENT, per-org bucket layout:
 *
 *   <prim-config>/moves/
 *     <envSlug>/                — one partition per API deployment (envSlug)
 *       <orgId>/journal.ndjson  — moves bound to a known org
 *       _unbound/journal.ndjson — moves captured without a resolved org
 *
 * The environment partition is load-bearing, not cosmetic: the server
 * attributes a flushed move to the AUTHENTICATED TOKEN's org regardless of
 * which deployment captured it, so a journal keyed by org alone let moves
 * captured against staging flush into prod (and become prod decisions). Keying
 * the bucket by deployment — and draining only the current deployment's
 * buckets (see listBuckets) — isolates each environment's captures end to end.
 * Per-org sub-buckets still keep one org's moves apart and let `prim moves
 * status` report per-bucket pending counts.
 *
 * Journals hold raw hook payloads (file contents, prompts, tool I/O), so
 * every file is created 0600 and its directory 0700 — the same posture the
 * CLI uses for its other credential-bearing files. The delivery path durably
 * quarantines malformed lines before retiring a rotation; read-only sampling
 * ignores them.
 */

import {
  appendFileSync,
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  readSync,
  readdirSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getSiteUrl } from "./client.js";
import { primConfigDirectory } from "./lib/paths.js";
import type { Move } from "./protocol/move.js";

export const JOURNAL_DIR = join(primConfigDirectory(), "moves");
const UNBOUND_BUCKET = "_unbound";
const JOURNAL_BASENAME = "journal.ndjson";
export const JOURNAL_STATS_SAMPLE_BYTES = 64 * 1024;
const PENDING_STATS_MAX_FILES = 128;

/**
 * A filesystem-safe slug for the resolved API base URL, used as the journal's
 * environment partition. The server attributes a flushed move to the active
 * token's org regardless of which deployment captured it, so a journal keyed by
 * org alone lets moves captured against one deployment flush into another (the
 * "staging decisions in production" bug). Partitioning the bucket path by
 * deployment — and draining only the CURRENT deployment's buckets — keeps each
 * environment's captures isolated end to end. Readable on purpose (e.g.
 * `api.getprimitive.ai`) so it is obvious on disk which deployment a bucket
 * belongs to.
 */
export function envSlug(apiUrl: string): string {
  const slug = apiUrl
    .replace(/^https?:\/\//, "")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
  // The slug is a filesystem path segment (join(JOURNAL_DIR, slug)), so a bare
  // "." or ".." must not survive: ".." escapes the moves tree and writes
  // secret-bearing journals one level up (beside the credential files), while
  // "." collapses every deployment back onto the unpartitioned root — the exact
  // cross-env contamination this partition exists to prevent. The char class
  // keeps "." so dotted hostnames (api.getprimitive.ai) stay readable, so the
  // dot-only segments are rejected explicitly here, mirroring the orgId
  // SAFE_BUCKET guard the per-org sub-bucket already has.
  if (slug.length === 0 || slug === "." || slug === "..") {
    return "default";
  }
  return slug;
}

function currentEnvDir(): string {
  return join(JOURNAL_DIR, envSlug(getSiteUrl()));
}

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

// orgId becomes a filesystem path segment, so it must be a single safe
// token. Anything else (path separators, `.`/`..`, a reserved bucket name,
// or an unresolved org) routes to _unbound rather than escaping the
// hardened tree or stranding moves in a path listBuckets never enumerates.
const SAFE_BUCKET = /^[A-Za-z0-9_-]+$/;
const RESERVED_BUCKETS = new Set([UNBOUND_BUCKET, "_legacy"]);

export function appendMoveToPath(path: string, move: Move): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  appendFileSync(path, `${JSON.stringify(move)}\n`, { mode: FILE_MODE });
}

function bucketDir(orgId: string | undefined): string {
  const safe = orgId !== undefined && SAFE_BUCKET.test(orgId) && !RESERVED_BUCKETS.has(orgId);
  // <moves>/<envSlug>/<orgId>: the env partition is what isolates one
  // deployment's captures from another's, so a flush only ever drains the
  // deployment it is currently targeting.
  return join(currentEnvDir(), safe ? orgId : UNBOUND_BUCKET);
}

export function journalPath(orgId: string | undefined): string {
  return join(bucketDir(orgId), JOURNAL_BASENAME);
}

export function appendMove(move: Move, orgId: string | undefined): void {
  // Route through appendMoveToPath so the per-bucket journal inherits the
  // 0600 file mode / 0700 dir mode (the payloads are secret-bearing).
  appendMoveToPath(journalPath(orgId), move);
}

function parseMoves(content: string): Move[] {
  const moves: Move[] = [];
  for (const line of content.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      moves.push(JSON.parse(line) as Move);
    } catch {
      // Read-only sampling ignores malformed lines. The flusher consumes the
      // exact bytes and durably quarantines them before retiring a rotation.
    }
  }
  return moves;
}

export function readMovesFromPath(path: string): Move[] {
  if (!existsSync(path)) {
    return [];
  }
  return parseMoves(readFileSync(path, "utf-8"));
}

/**
 * The org-bucket journals for the CURRENT deployment only (path-only — no stat
 * or read). Scoping to the current env's partition is the load-bearing
 * isolation: the flusher drives its drain off this, so it can only ever send a
 * deployment its own captures — never another's. Buckets under a different env
 * slug (and any pre-partition legacy layout) are intentionally not enumerated
 * here, so they are orphaned rather than mis-flushed across deployments.
 */
export function listBuckets(): Array<{ bucket: string; path: string }> {
  const out: Array<{ bucket: string; path: string }> = [];
  const envDir = currentEnvDir();
  if (!existsSync(envDir)) {
    return out;
  }
  for (const entry of readdirSync(envDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const path = join(envDir, entry.name, JOURNAL_BASENAME);
    if (existsSync(path)) {
      out.push({ bucket: entry.name, path });
    }
  }
  return out;
}

const FLUSHING_PREFIX = `${JOURNAL_BASENAME}.flushing.`;

export type FlushingFile = {
  bucket: string;
  path: string;
  // The drain pid embedded in the filename, or undefined for the legacy
  // pid-less variant. Recovery uses it to tell a crashed drain's orphan from
  // a file a live drain still owns.
  pid: number | undefined;
  sizeBytes: number;
  mtimeMs: number;
  lineCount: number;
  oldestCapturedAt?: number;
  /** True when lineCount is a lower bound from a fixed-size prefix. */
  sampled: boolean;
  sampledBytes: number;
};

function oldestCapturedAt(moves: Move[]): number | undefined {
  let oldest: number | undefined;
  for (const move of moves) {
    if (!Number.isFinite(move.capturedAt)) {
      continue;
    }
    oldest = oldest === undefined ? move.capturedAt : Math.min(oldest, move.capturedAt);
  }
  return oldest;
}

export type JournalFileSample = {
  sizeBytes: number;
  mtimeMs: number;
  lineCount: number;
  oldestCapturedAt?: number;
  sampled: boolean;
  sampledBytes: number;
};

/** Read only a fixed prefix; sampled line counts are explicit lower bounds. */
export function sampleJournalFile(
  path: string,
  maxBytes: number = JOURNAL_STATS_SAMPLE_BYTES,
): JournalFileSample {
  const fd = openSync(path, "r");
  try {
    const initial = fstatSync(fd);
    const target = Math.min(initial.size, Math.max(0, maxBytes));
    const buffer = Buffer.allocUnsafe(target);
    let sampledBytes = 0;
    while (sampledBytes < target) {
      const count = readSync(fd, buffer, sampledBytes, target - sampledBytes, sampledBytes);
      if (count === 0) {
        break;
      }
      sampledBytes += count;
    }
    const stat = fstatSync(fd);
    const sampled = stat.size > sampledBytes;
    let content = buffer.subarray(0, sampledBytes).toString("utf-8");
    if (sampled) {
      // The prefix may end inside a UTF-8 sequence or JSON record. Only parse
      // newline-terminated records that are known to be complete.
      const lastNewline = content.lastIndexOf("\n");
      content = lastNewline === -1 ? "" : content.slice(0, lastNewline + 1);
    }
    const lines = content.split("\n").filter((line) => line.length > 0);
    const moves = parseMoves(content);
    return {
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount: sampled && stat.size > 0 ? Math.max(1, lines.length) : lines.length,
      oldestCapturedAt: oldestCapturedAt(moves),
      sampled,
      sampledBytes,
    };
  } finally {
    closeSync(fd);
  }
}

function parseFlushingPid(name: string): number | undefined {
  // The flusher names rotations `journal.ndjson.flushing.<ts>.<pid>`; older
  // builds emitted `journal.ndjson.flushing.<ts>` with no pid. Treat a
  // trailing all-digits segment beyond the timestamp as the owning pid.
  const segments = name.slice(FLUSHING_PREFIX.length).split(".");
  const last = segments.length >= 2 ? segments[segments.length - 1] : undefined;
  return last !== undefined && /^[0-9]+$/.test(last) ? Number(last) : undefined;
}

/**
 * Orphaned `.flushing` rotation files in one directory. Path-parameterized so
 * it unit-tests without the real config tree. A `.flushing` file is left
 * behind whenever a drain dies between the journal→`.flushing` rename and the
 * unlink-on-success; nothing else enumerates them, so both `prim moves status`
 * and the recovery sweep read this.
 */
export function listFlushingInDir(
  dir: string,
  bucket: string,
  options: { sampleBytes?: number; maxFiles?: number } = {},
): FlushingFile[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: FlushingFile[] = [];
  let remainingBytes = options.sampleBytes ?? JOURNAL_STATS_SAMPLE_BYTES;
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const entries = opendirSync(dir);
  try {
    let entry = entries.readSync();
    while (entry && out.length < maxFiles) {
      if (!entry.isFile() || !entry.name.startsWith(FLUSHING_PREFIX)) {
        entry = entries.readSync();
        continue;
      }
      const path = join(dir, entry.name);
      let sample: JournalFileSample;
      try {
        sample = sampleJournalFile(path, remainingBytes);
      } catch (err) {
        // A concurrent drain may unlink the rotation between readdir and stat.
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          entry = entries.readSync();
          continue;
        }
        throw err;
      }
      remainingBytes = Math.max(0, remainingBytes - sample.sampledBytes);
      out.push({
        bucket,
        path,
        pid: parseFlushingPid(entry.name),
        ...sample,
      });
      entry = entries.readSync();
    }
  } finally {
    entries.closeSync();
  }
  return out;
}

/**
 * Stranded `.flushing` files (a crashed drain's leftovers) for the CURRENT
 * deployment only — the in-bucket siblings of each org's journal.ndjson under
 * this env's partition. Env-scoped like listBuckets so recovery re-drains a
 * crashed flush back to the SAME deployment it came from, never across
 * environments; leftovers under another env slug (or a pre-partition legacy
 * layout) are orphaned, not mis-flushed. listBuckets() never names these.
 */
export function listFlushing(
  options: { sampleBytes?: number; maxFiles?: number } = {},
): FlushingFile[] {
  const envDir = currentEnvDir();
  if (!existsSync(envDir)) {
    return [];
  }
  const out: FlushingFile[] = [];
  let remainingBytes = options.sampleBytes ?? JOURNAL_STATS_SAMPLE_BYTES;
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  for (const entry of readdirSync(envDir, { withFileTypes: true })) {
    if (out.length >= maxFiles) {
      break;
    }
    if (entry.isDirectory()) {
      const found = listFlushingInDir(join(envDir, entry.name), entry.name, {
        sampleBytes: remainingBytes,
        maxFiles: maxFiles - out.length,
      });
      out.push(...found);
      remainingBytes = Math.max(
        0,
        remainingBytes - found.reduce((count, file) => count + file.sampledBytes, 0),
      );
    }
  }
  return out;
}

export type BucketStats = {
  bucket: string;
  path: string;
  sizeBytes: number;
  mtimeMs: number;
  lineCount: number;
  oldestCapturedAt?: number;
  sampled: boolean;
  sampledBytes: number;
};

export function bucketStats(
  options: { sampleBytes?: number; maxFiles?: number } = {},
): BucketStats[] {
  const out: BucketStats[] = [];
  let remainingBytes = options.sampleBytes ?? JOURNAL_STATS_SAMPLE_BYTES;
  const maxFiles = options.maxFiles ?? Number.POSITIVE_INFINITY;
  for (const { bucket, path } of listBuckets()) {
    if (out.length >= maxFiles) {
      break;
    }
    let sample: JournalFileSample;
    try {
      sample = sampleJournalFile(path, remainingBytes);
    } catch (err) {
      // The flusher rotates with rename, so enumeration can legitimately race
      // a path that no longer exists.
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }
    remainingBytes = Math.max(0, remainingBytes - sample.sampledBytes);
    out.push({
      bucket,
      path,
      ...sample,
    });
  }
  return out;
}

export type PendingJournalStats = {
  pendingCount: number;
  oldestPendingAt?: number;
  strandedCount: number;
  strandedFileCount: number;
  /** Counts are lower bounds whenever the fixed byte/file budget was hit. */
  sampled: boolean;
  strandedSampled: boolean;
};

/** Aggregate live journals and rotations, including an orphan-only queue. */
export function pendingJournalStats(): PendingJournalStats {
  const perKindBytes = Math.floor(JOURNAL_STATS_SAMPLE_BYTES / 2);
  const perKindFiles = Math.floor(PENDING_STATS_MAX_FILES / 2);
  const live = bucketStats({ sampleBytes: perKindBytes, maxFiles: perKindFiles });
  const stranded = listFlushing({ sampleBytes: perKindBytes, maxFiles: perKindFiles });
  const timestamps = [...live, ...stranded]
    .map((entry) => entry.oldestCapturedAt)
    .filter((value): value is number => value !== undefined);
  const liveSampled = live.some((entry) => entry.sampled) || live.length >= perKindFiles;
  const strandedSampled =
    stranded.some((entry) => entry.sampled) || stranded.length >= perKindFiles;
  return {
    pendingCount:
      live.reduce((count, entry) => count + entry.lineCount, 0) +
      stranded.reduce((count, entry) => count + entry.lineCount, 0),
    oldestPendingAt: timestamps.length > 0 ? Math.min(...timestamps) : undefined,
    strandedCount: stranded.reduce((count, entry) => count + entry.lineCount, 0),
    strandedFileCount: stranded.length,
    sampled: liveSampled || strandedSampled,
    strandedSampled,
  };
}
