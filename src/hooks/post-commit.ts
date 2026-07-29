#!/usr/bin/env node
/**
 * prim-post-commit — emit a git.commit move after each commit.
 *
 * Runs as a git post-commit hook (installed by `prim hooks install`). Reads
 * the just-created commit locally (no network), wraps it in a git.commit
 * Move, appends it to the org journal, and spawns a detached flush so the
 * commit and the session's preceding agent moves reach the server
 * together. The backend resolves which agent session the commit belongs to
 * and classifies that window's decisions.
 *
 * Fail-soft: any error is swallowed (set PRIM_HOOK_DEBUG to surface it) and
 * the process always exits 0 — a commit is never blocked or delayed.
 *
 * The version/flush helpers mirror prim-hook.ts deliberately: this is a
 * separate process with no shared state, and keeping it self-contained
 * keeps shared-module resolution off the commit cold path.
 */
import { execFileSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOrg } from "../binding.js";
import { appendMove } from "../journal.js";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { githubRepositoryFullName, resolveRepositoryContext } from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import {
  type CommitInfo,
  commitAttributionFromEnvironment,
  toCommitMove,
} from "./prim-hook-core.js";

const here = dirname(fileURLToPath(import.meta.url));
const GIT_TIMEOUT_MS = 1_000;
const FULL_SHA_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

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

function gitBytes(args: string[]): Buffer | undefined {
  try {
    return execFileSync("git", args, {
      encoding: "buffer",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return;
  }
}

function parseNulPaths(value: Buffer): { files: string[]; complete: boolean } {
  if (value.length === 0) return { files: [], complete: true };
  const chunks: Buffer[] = [];
  let start = 0;
  for (let i = 0; i < value.length; i += 1) {
    if (value[i] !== 0) continue;
    chunks.push(value.subarray(start, i));
    start = i + 1;
  }
  if (start !== value.length || chunks.some((chunk) => chunk.length === 0)) {
    return { files: [], complete: false };
  }
  const files: string[] = [];
  for (const chunk of chunks) {
    const file = chunk.toString("utf8");
    if (!Buffer.from(file, "utf8").equals(chunk)) {
      return { files: [], complete: false };
    }
    files.push(file);
  }
  return { files: [...new Set(files)], complete: true };
}

function readCommit(): CommitInfo | null {
  const snapshotProvided = process.env.PRIM_COMMIT_SHA !== undefined;
  const sha = snapshotProvided ? process.env.PRIM_COMMIT_SHA : gitText(["rev-parse", "HEAD"]);
  if (!sha || !FULL_SHA_RE.test(sha)) {
    return null;
  }
  const rawBranch =
    process.env.PRIM_COMMIT_BRANCH !== undefined
      ? process.env.PRIM_COMMIT_BRANCH
      : gitText(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch =
    rawBranch &&
    rawBranch === rawBranch.trim() &&
    ![...rawBranch].some((char) => char < " " || char === "\u007f")
      ? rawBranch
      : undefined;
  const rawFiles = gitBytes([
    "diff-tree",
    "--no-commit-id",
    "--name-only",
    "-z",
    "-r",
    "-m",
    "--root",
    sha,
  ]);
  const { files, complete } =
    rawFiles === undefined ? { files: [], complete: false } : parseNulPaths(rawFiles);
  return {
    sha,
    parentSha: gitText(["rev-parse", "--verify", "--quiet", `${sha}^`]) || undefined,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    files,
    filesComplete: complete,
  };
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

export function runPostCommit(): void {
  const cwd = gitText(["rev-parse", "--show-toplevel"]) ?? process.cwd();
  if (!isRepoActiveForCapture(cwd)) {
    return;
  }
  const commit = readCommit();
  if (commit) {
    const repository = resolveRepositoryContext(cwd);
    const identity = getOrCreateWorkspaceId(cwd);
    const workspaceId = identity.status === "ready" ? identity.workspaceId : undefined;
    const attribution = commitAttributionFromEnvironment(process.env, workspaceId);
    const move = toCommitMove(commit, resolveCliVersion(), cwd, {
      repository,
      repoFullName: githubRepositoryFullName(cwd) ?? undefined,
      repoSyncId: repoSyncId(cwd),
      workspaceId,
      attribution,
    });
    const { orgId } = resolveOrg({ sessionId: move.sessionId, cwd });
    appendMove(move, orgId);
    spawnBackgroundFlush();
  }
}

if (!process.env.VITEST) {
  try {
    runPostCommit();
  } catch (err) {
    if (process.env.PRIM_HOOK_DEBUG) {
      const detail = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[prim-post-commit] capture failed: ${detail}\n`);
    }
  }
  process.exit(0);
}
