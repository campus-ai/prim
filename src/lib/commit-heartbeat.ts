/**
 * Did post-commit actually reach prim? Evidence, not file inspection.
 *
 * Reading hook files cannot prove capture. A block can sit behind an `exit` a
 * heuristic misses, a hook manager can wire prim by hand, or the committing
 * process (an IDE, a GUI client) can lack the environment that locates prim's
 * config root. So the post-commit driver stamps each run, and doctor compares
 * the stamp with Git's own record of local commits: the HEAD reflog.
 *
 * Stamps live beside the workspace id, in this checkout's git dir (`git
 * rev-parse --git-path prim/…`), so they are per worktree like the reflog they
 * are checked against, and never touch `.git/config` from a background hook.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { repoActiveFlag } from "./activation.js";
import { atomicWriteFile } from "./atomic-file.js";

const FIRED_PATH = "prim/post-commit-fired";
const WIRED_PATH = "prim/git-hooks-wired";
const GIT_TIMEOUT_MS = 1_000;
const MAX_STAMP_BYTES = 1_024;
const REFLOG_SCAN_LIMIT = 50;
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const REFLOG_LINE_RE = /^HEAD@\{([0-9]+)\}\t(.*)$/u;
// Every reflog subject Git writes for a commit that runs post-commit.
const COMMIT_SUBJECT_RE = /^commit(?: \((?:initial|amend|merge)\))?:/u;

/** Reflog times have one-second resolution; the stamp is taken just after. */
const CLOCK_SKEW_MS = 5_000;
/** The detached driver may still be starting right after a commit. */
export const POST_COMMIT_GRACE_MS = 60_000;

type Stamp = { at: number; sha?: string };

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

function writeStamp(cwd: string, relative: string, stamp: Stamp): void {
  try {
    atomicWriteFile(gitPath(cwd, relative), `${JSON.stringify(stamp)}\n`, {
      ensureParent: true,
      mode: 0o600,
    });
  } catch {
    // Evidence is best effort: a commit hook must never fail on it.
  }
}

function readStamp(cwd: string, relative: string): Stamp | undefined {
  try {
    const raw = readFileSync(gitPath(cwd, relative), "utf8");
    if (raw.length > MAX_STAMP_BYTES) return undefined;
    const parsed = JSON.parse(raw) as { at?: unknown; sha?: unknown };
    if (typeof parsed.at !== "number" || !Number.isSafeInteger(parsed.at) || parsed.at <= 0) {
      return undefined;
    }
    const sha = typeof parsed.sha === "string" && FULL_SHA_RE.test(parsed.sha) ? parsed.sha : "";
    return sha ? { at: parsed.at, sha } : { at: parsed.at };
  } catch {
    return undefined;
  }
}

/** Called by the post-commit driver on every run that reaches prim. */
export function recordPostCommitFired(
  cwd: string,
  sha: string | undefined,
  now: number = Date.now(),
): void {
  writeStamp(cwd, FIRED_PATH, sha && FULL_SHA_RE.test(sha) ? { at: now, sha } : { at: now });
}

/** Called when an explicit command wires this checkout's hooks. */
export function recordHooksWired(cwd: string, now: number = Date.now()): void {
  writeStamp(cwd, WIRED_PATH, { at: now });
}

/** When HEAD last moved because of a local commit, from this worktree's reflog. */
export function latestLocalCommitAt(cwd: string): number | undefined {
  let output: string;
  try {
    output = execFileSync(
      "git",
      ["log", "-g", "-n", String(REFLOG_SCAN_LIMIT), "--date=unix", "--format=%gd%x09%gs", "HEAD"],
      { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: GIT_TIMEOUT_MS },
    );
  } catch {
    return undefined; // No reflog yet (an unborn branch, or reflogs disabled).
  }
  for (const line of output.split("\n")) {
    const match = REFLOG_LINE_RE.exec(line);
    if (match?.[1] && COMMIT_SUBJECT_RE.test(match[2] ?? "")) return Number(match[1]) * 1_000;
  }
  return undefined;
}

/**
 * Judge only commits after the hooks were last wired or last fired: before
 * that, nobody promised a run. A stamp older than the latest commit means the
 * hook stopped reaching prim.
 */
export function inspectPostCommitFiring(cwd: string, now: number = Date.now()): PostCommitFiring {
  if (repoActiveFlag(cwd) !== "true") return { state: "inactive" };
  const commitAt = latestLocalCommitAt(cwd);
  if (commitAt === undefined) return { state: "unverified" };
  const fired = readStamp(cwd, FIRED_PATH);
  if (fired && fired.at >= commitAt - CLOCK_SKEW_MS) {
    return { state: "fired", commitAt, firedAt: fired.at };
  }
  if (now - commitAt < POST_COMMIT_GRACE_MS) return { state: "pending", commitAt };
  const wired = readStamp(cwd, WIRED_PATH);
  const expectedSince = Math.max(wired?.at ?? 0, fired?.at ?? 0);
  if (expectedSince > 0 && commitAt > expectedSince) {
    return fired
      ? { state: "not_firing", commitAt, firedAt: fired.at }
      : { state: "not_firing", commitAt };
  }
  return { state: "unverified" };
}
