#!/usr/bin/env node
/**
 * prim-post-rewrite — emit deterministic git.rewrite moves after amend/rebase.
 *
 * Git supplies rewrite pairs on stdin. The shell launcher snapshots that stream
 * synchronously into a private file before detaching this driver, so Git and any
 * chained hook are never coupled to journal or network latency. Every failure is
 * fail-soft and the executable always exits zero.
 */
import { execFileSync, spawn } from "node:child_process";
import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
  unlinkSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOrg } from "../binding.js";
import { appendMove } from "../journal.js";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { githubRepositoryFullName, resolveRepositoryContext } from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import {
  type RewritePair,
  type RewriteSource,
  canonicalRewritePairs,
  toRewriteMove,
} from "./prim-hook-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const GIT_TIMEOUT_MS = 1_000;
const MAX_PAIRS_FILE_BYTES = 1_048_576;
const MAX_PAIRS_FILE_AGE_MS = 10 * 60 * 1_000;
const MAX_PAIRS_FILE_FUTURE_SKEW_MS = 5_000;
const PAIRS_FILE_RE = /^prim-post-rewrite-pairs\.[A-Za-z0-9]+$/u;
const FULL_SHA_SOURCE = "(?:[0-9a-fA-F]{40}|[0-9a-fA-F]{64})";
const REWRITE_PAIR_RE = new RegExp(
  `^(${FULL_SHA_SOURCE}) (${FULL_SHA_SOURCE})(?: ([^\\s]+))?$`,
  "u",
);

type RewritePairsSnapshot = {
  path: string;
  dev: number;
  ino: number;
  capturedAt: number;
  pairs: RewritePair[];
};

/** Strictly parse the post-rewrite protocol, then canonicalize and cap it. */
export function parseRewritePairs(value: string): RewritePair[] | undefined {
  if (value.length === 0) return [];
  const body = value.endsWith("\n") ? value.slice(0, -1) : value;
  if (body.length === 0) return [];
  const parsed: RewritePair[] = [];
  for (const line of body.split("\n")) {
    const match = REWRITE_PAIR_RE.exec(line);
    if (!match?.[1] || !match[2]) return;
    parsed.push({ oldSha: match[1], newSha: match[2] });
  }
  return canonicalRewritePairs(parsed) ?? undefined;
}

function privatePairsFileStat(stat: Stats, now: number): boolean {
  const capturedAt = Math.trunc(stat.mtimeMs);
  const uid = process.getuid?.();
  return (
    stat.isFile() &&
    !stat.isSymbolicLink() &&
    stat.size <= MAX_PAIRS_FILE_BYTES &&
    stat.nlink === 1 &&
    (stat.mode & 0o777) === 0o600 &&
    (uid === undefined || stat.uid === uid) &&
    Number.isSafeInteger(capturedAt) &&
    capturedAt > 0 &&
    capturedAt >= now - MAX_PAIRS_FILE_AGE_MS &&
    capturedAt <= now + MAX_PAIRS_FILE_FUTURE_SKEW_MS
  );
}

/**
 * Validate and read only the private file shape minted by the shell launcher.
 * lstat/open/fstat identity checks prevent symlink and replacement races.
 */
export function rewritePairsFromLauncher(
  env: NodeJS.ProcessEnv = process.env,
  now: number = Date.now(),
): RewritePairsSnapshot | undefined {
  const path = env.PRIM_REWRITE_PAIRS_FILE;
  if (!path || !isAbsolute(path) || !PAIRS_FILE_RE.test(basename(path))) return;
  let fd: number | undefined;
  try {
    const pathStat = lstatSync(path);
    if (!privatePairsFileStat(pathStat, now)) return;
    fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    const openStat = fstatSync(fd);
    if (
      !privatePairsFileStat(openStat, now) ||
      openStat.dev !== pathStat.dev ||
      openStat.ino !== pathStat.ino
    ) {
      return;
    }
    const bytes = readFileSync(fd);
    if (bytes.length !== openStat.size) return;
    let text: string;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      return;
    }
    const pairs = parseRewritePairs(text);
    if (!pairs) return;
    return {
      path,
      dev: openStat.dev,
      ino: openStat.ino,
      capturedAt: Math.trunc(openStat.mtimeMs),
      pairs,
    };
  } catch {
    return;
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // The shell launcher's EXIT trap remains a final cleanup backstop.
      }
    }
  }
}

function unlinkSnapshot(snapshot: RewritePairsSnapshot): void {
  try {
    const current = lstatSync(snapshot.path);
    if (
      current.isFile() &&
      !current.isSymbolicLink() &&
      current.dev === snapshot.dev &&
      current.ino === snapshot.ino
    ) {
      unlinkSync(snapshot.path);
    }
  } catch {
    // The shell trap may already have removed it; cleanup is best effort.
  }
}

function gitText(args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return;
  }
}

function validSource(value: string | undefined): value is RewriteSource {
  return value === "amend" || value === "rebase";
}

function validBranch(value: string | undefined): string | undefined {
  return value &&
    value === value.trim() &&
    ![...value].some((char) => char < " " || char === "\u007f")
    ? value
    : undefined;
}

function resolveCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function spawnBackgroundFlush(): void {
  const entry = join(here, "..", "index.js");
  spawn(process.execPath, [entry, "moves", "flush"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

export function runPostRewrite(): void {
  const snapshot = rewritePairsFromLauncher();
  if (!snapshot) return;
  try {
    const source = process.env.PRIM_REWRITE_SOURCE;
    if (!validSource(source) || snapshot.pairs.length === 0) return;
    const cwd = gitText(["rev-parse", "--show-toplevel"]) ?? process.cwd();
    if (!isRepoActiveForCapture(cwd)) return;
    const repository = resolveRepositoryContext(cwd);
    const identity = getOrCreateWorkspaceId(cwd);
    const workspaceId = identity.status === "ready" ? identity.workspaceId : undefined;
    const moves = toRewriteMove(
      {
        source,
        pairs: snapshot.pairs,
        branch: validBranch(process.env.PRIM_REWRITE_BRANCH),
      },
      resolveCliVersion(),
      cwd,
      {
        repository,
        repoFullName: githubRepositoryFullName(cwd) ?? undefined,
        repoSyncId: repoSyncId(cwd),
        workspaceId,
        capturedAt: snapshot.capturedAt,
      },
    );
    if (moves.length === 0) return;
    const { orgId } = resolveOrg({ sessionId: "", cwd });
    for (const move of moves) appendMove(move, orgId);
    spawnBackgroundFlush();
  } finally {
    unlinkSnapshot(snapshot);
  }
}

if (!process.env.VITEST) {
  try {
    runPostRewrite();
  } catch (error) {
    if (process.env.PRIM_HOOK_DEBUG) {
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[prim-post-rewrite] capture failed: ${detail}\n`);
    }
  }
  process.exit(0);
}
