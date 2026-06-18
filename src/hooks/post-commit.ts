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
import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOrg } from "../binding.js";
import { appendMove } from "../journal.js";
import { type CommitInfo, toCommitMove } from "./prim-hook-core.js";

const here = dirname(fileURLToPath(import.meta.url));

function git(args: string): string | undefined {
  try {
    return execSync(`git ${args}`, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return;
  }
}

function readCommit(): CommitInfo | null {
  const sha = git("rev-parse HEAD");
  if (!sha) {
    return null;
  }
  const branch = git("rev-parse --abbrev-ref HEAD");
  const files = (git("diff-tree --no-commit-id --name-only -r -m --root HEAD") ?? "")
    .split("\n")
    .filter((f) => f.length > 0);
  return {
    sha,
    parentSha: git("rev-parse --verify --quiet HEAD^") || undefined,
    branch: branch && branch !== "HEAD" ? branch : undefined,
    files,
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

try {
  const commit = readCommit();
  if (commit) {
    const cwd = git("rev-parse --show-toplevel") ?? process.cwd();
    const move = toCommitMove(commit, resolveCliVersion(), cwd);
    const { orgId } = resolveOrg({ sessionId: "", cwd });
    appendMove(move, orgId);
    spawnBackgroundFlush();
  }
} catch (err) {
  if (process.env.PRIM_HOOK_DEBUG) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[prim-post-commit] capture failed: ${detail}\n`);
  }
}
process.exit(0);
