/**
 * Did post-commit actually reach prim? Evidence, not file inspection.
 *
 * Reading hook files cannot prove capture. A block can sit behind an `exit` a
 * heuristic misses, a hook manager can wire prim by hand, or the committing
 * process (an IDE, a GUI client) can lack the environment that locates prim's
 * config root. So the post-commit driver stamps each commit it sees, and doctor
 * checks the latest local commit in Git's own record, the HEAD reflog, against
 * those stamps by SHA.
 *
 * Stamps live beside the workspace id, in this checkout's git dir (`git
 * rev-parse --git-path prim/…`), so they are per worktree like the reflog they
 * are checked against, and never touch `.git/config` from a background hook.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { repoActiveFlag } from "./activation.js";
import { atomicWriteFile } from "./atomic-file.js";

const FIRED_DIR = "prim/post-commit-fired";
const WIRED_PATH = "prim/git-hooks-wired";
const GIT_TIMEOUT_MS = 1_000;
const MAX_STAMP_BYTES = 1_024;
const REFLOG_SCAN_LIMIT = 50;
/** Stamps kept per checkout; doctor only ever needs the latest commit's. */
const MAX_FIRED_STAMPS = 32;
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REFLOG_LINE_RE = /^([0-9a-f]{40}|[0-9a-f]{64})\tHEAD@\{([0-9]+)\}\t(.*)$/u;
/**
 * Reflog subjects of `git commit`, which runs post-commit: `commit:` and any
 * `commit (…):` variant (initial, amend, merge, cherry-pick). Other commands
 * that run post-commit, such as rebase picks, are simply not judged.
 */
const COMMIT_SUBJECT_RE = /^commit(?: \([^)]*\))?:/u;

const REFLOG_RESOLUTION_MS = 1_000;

/** The detached driver may still be starting right after a commit. */
export const POST_COMMIT_GRACE_MS = 60_000;

export type PostCommitFiring =
  /** prim.active is not true here, so no run is expected. */
  | { state: "inactive" }
  /** No local commit to check since the hooks were wired (or ever). */
  | { state: "unverified" }
  /** The latest local commit is too recent to judge. */
  | { state: "pending"; commitAt: number }
  /** post-commit reached prim for the latest local commit. */
  | { state: "fired"; commitAt: number; firedAt: number }
  /** A local commit after the hooks were wired never reached prim. */
  | { state: "not_firing"; commitAt: number; firedAt?: number };

function gitPath(cwd: string, relative: string): string {
  const value = execFileSync("git", ["rev-parse", "--git-path", relative], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
  }).replace(/\r?\n$/u, "");
  if (value === "" || /[\0\r\n]/u.test(value)) throw new Error("Git returned an unsafe path");
  return resolve(cwd, value);
}

/** Create `<git dir>/prim` private, as the workspace id does. */
function ensurePrivateParent(path: string): void {
  mkdirSync(dirname(dirname(path)), { recursive: true, mode: 0o700 });
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
}

function writeStamp(path: string, at: number): void {
  ensurePrivateParent(path);
  atomicWriteFile(path, `${JSON.stringify({ at })}\n`, { mode: 0o600 });
}

function readStampAt(path: string): number | undefined {
  try {
    const raw = readFileSync(path, "utf8");
    if (raw.length > MAX_STAMP_BYTES) return undefined;
    const parsed = JSON.parse(raw) as { at?: unknown };
    return typeof parsed.at === "number" && Number.isSafeInteger(parsed.at) && parsed.at > 0
      ? parsed.at
      : undefined;
  } catch {
    return undefined;
  }
}

type FiredStamp = { sha: string; at: number };

function readFiredStamps(cwd: string): FiredStamp[] {
  try {
    const dir = gitPath(cwd, FIRED_DIR);
    return readdirSync(dir).flatMap((sha) => {
      if (!FULL_SHA_RE.test(sha)) return [];
      const at = readStampAt(join(dir, sha));
      return at === undefined ? [] : [{ sha, at }];
    });
  } catch {
    return [];
  }
}

/**
 * Called by the post-commit driver on every run that reaches prim. One file
 * per commit, so concurrent drivers for rapid commits never overwrite each
 * other's evidence. Best effort: a commit hook must never fail on it.
 */
export function recordPostCommitFired(
  cwd: string,
  sha: string | undefined,
  now: number = Date.now(),
): void {
  if (!sha || !FULL_SHA_RE.test(sha)) return;
  try {
    const dir = gitPath(cwd, FIRED_DIR);
    writeStamp(join(dir, sha), now);
    const stale = readdirSync(dir)
      .filter((name) => FULL_SHA_RE.test(name))
      .map((name) => ({ name, at: readStampAt(join(dir, name)) ?? 0 }))
      .sort((left, right) => right.at - left.at || left.name.localeCompare(right.name))
      .slice(MAX_FIRED_STAMPS);
    for (const { name } of stale) unlinkSync(join(dir, name));
  } catch {
    // Evidence is best effort.
  }
}

/**
 * Called when the hooks are (re)wired for an active checkout: from then on,
 * doctor expects every local commit to reach prim. `onlyIfAbsent` keeps an
 * existing expectation (a re-run that changed nothing proves nothing).
 */
export function recordHooksWired(
  cwd: string,
  options: { now?: number; onlyIfAbsent?: boolean } = {},
): void {
  try {
    const path = gitPath(cwd, WIRED_PATH);
    if (options.onlyIfAbsent && readStampAt(path) !== undefined) return;
    writeStamp(path, options.now ?? Date.now());
  } catch {
    // Evidence is best effort.
  }
}

/** The latest local commit in this worktree's HEAD reflog. */
export function latestLocalCommit(cwd: string): { sha: string; at: number } | undefined {
  let output: string;
  try {
    output = execFileSync(
      "git",
      [
        "log",
        "-g",
        "--no-show-signature",
        "-n",
        String(REFLOG_SCAN_LIMIT),
        "--date=unix",
        "--format=%H%x09%gd%x09%gs",
        "HEAD",
      ],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS },
    );
  } catch {
    return undefined; // No reflog yet (an unborn branch, or reflogs disabled).
  }
  for (const line of output.split("\n")) {
    const match = REFLOG_LINE_RE.exec(line);
    if (match?.[1] && match[2] && COMMIT_SUBJECT_RE.test(match[3] ?? "")) {
      return { sha: match[1], at: Number(match[2]) * 1_000 };
    }
  }
  return undefined;
}

/**
 * Judge only commits after the hooks were wired for an active checkout or
 * after prim last saw a commit: before that, nobody promised a run.
 */
export function inspectPostCommitFiring(cwd: string, now: number = Date.now()): PostCommitFiring {
  if (repoActiveFlag(cwd) !== "true") return { state: "inactive" };
  const commit = latestLocalCommit(cwd);
  if (!commit) return { state: "unverified" };
  const stamps = readFiredStamps(cwd);
  const own = stamps.find((stamp) => stamp.sha === commit.sha);
  if (own) return { state: "fired", commitAt: commit.at, firedAt: own.at };
  if (now - commit.at < POST_COMMIT_GRACE_MS) return { state: "pending", commitAt: commit.at };
  const lastFiredAt = stamps.reduce<number | undefined>(
    (latest, stamp) => (latest === undefined || stamp.at > latest ? stamp.at : latest),
    undefined,
  );
  let wiredAt: number | undefined;
  try {
    wiredAt = readStampAt(gitPath(cwd, WIRED_PATH));
  } catch {
    wiredAt = undefined;
  }
  const expectedSince = Math.max(wiredAt ?? 0, lastFiredAt ?? 0);
  // Reflog times are whole seconds: a commit stamped 12:00:00 may have happened
  // at 12:00:00.999, after an expectation recorded within that second.
  if (expectedSince > 0 && commit.at + REFLOG_RESOLUTION_MS > expectedSince) {
    return lastFiredAt === undefined
      ? { state: "not_firing", commitAt: commit.at }
      : { state: "not_firing", commitAt: commit.at, firedAt: lastFiredAt };
  }
  return { state: "unverified" };
}
