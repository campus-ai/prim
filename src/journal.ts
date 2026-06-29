/**
 * Decision Event Pipeline — local NDJSON journal.
 *
 * Moves are journaled under a per-ENVIRONMENT, per-org bucket layout:
 *
 *   ~/.config/prim/moves/
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
 * CLI uses for its other credential-bearing files. Malformed lines are
 * skipped, never fatal.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { getSiteUrl } from "./client.js";
import type { Move } from "./protocol/move.js";

export const JOURNAL_DIR = join(homedir(), ".config", "prim", "moves");
const UNBOUND_BUCKET = "_unbound";
const JOURNAL_BASENAME = "journal.ndjson";

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
  return slug.length > 0 ? slug : "default";
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

export function readMovesFromPath(path: string): Move[] {
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, "utf-8");
  const moves: Move[] = [];
  for (const line of content.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      moves.push(JSON.parse(line) as Move);
    } catch {
      // Skip malformed lines rather than abort the drain.
    }
  }
  return moves;
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
};

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
export function listFlushingInDir(dir: string, bucket: string): FlushingFile[] {
  if (!existsSync(dir)) {
    return [];
  }
  const out: FlushingFile[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.startsWith(FLUSHING_PREFIX)) {
      continue;
    }
    const path = join(dir, entry.name);
    const stat = statSync(path);
    const lineCount = readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0).length;
    out.push({
      bucket,
      path,
      pid: parseFlushingPid(entry.name),
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount,
    });
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
export function listFlushing(): FlushingFile[] {
  const envDir = currentEnvDir();
  if (!existsSync(envDir)) {
    return [];
  }
  const out: FlushingFile[] = [];
  for (const entry of readdirSync(envDir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      out.push(...listFlushingInDir(join(envDir, entry.name), entry.name));
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
};

export function bucketStats(): BucketStats[] {
  return listBuckets().map(({ bucket, path }) => {
    const stat = statSync(path);
    const content = readFileSync(path, "utf-8");
    const lineCount = content.split("\n").filter((l) => l.length > 0).length;
    return {
      bucket,
      path,
      sizeBytes: stat.size,
      mtimeMs: stat.mtimeMs,
      lineCount,
    };
  });
}
