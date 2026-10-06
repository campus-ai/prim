import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST_COMMIT_GRACE_MS,
  inspectPostCommitFiring,
  recordHooksWired,
} from "../lib/commit-heartbeat.js";
import { runPostCommit } from "./post-commit.js";

// Capture itself is out of scope: stop right after the evidence is recorded.
vi.mock("../lib/activation.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/activation.js")>()),
  isRepoActiveForCapture: vi.fn(() => false),
}));

const roots: string[] = [];
const startDir = process.cwd();

function temp(prefix: string): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function commitAndRunDriver(checkout: string, message: string, env: Record<string, string> = {}) {
  git(checkout, "commit", "-q", "--allow-empty", "-m", message);
  vi.stubEnv("PRIM_COMMIT_SHA", git(checkout, "rev-parse", "HEAD"));
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value);
  // Git runs post-commit from the top of the worktree.
  process.chdir(checkout);
  try {
    runPostCommit();
  } finally {
    process.chdir(startDir);
    for (const key of Object.keys(env)) vi.stubEnv(key, undefined as unknown as string);
  }
}

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
});

afterEach(() => {
  process.chdir(startDir);
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the post-commit driver's evidence", () => {
  it("lands where doctor looks, in the main checkout and in a linked worktree", () => {
    const root = temp("prim-driver-evidence-");
    git(root, "init", "-q");
    git(root, "config", "user.name", "Prim Test");
    git(root, "config", "user.email", "prim@example.test");
    git(root, "config", "commit.gpgsign", "false");
    git(root, "config", "prim.active", "true");
    git(root, "commit", "-q", "--allow-empty", "-m", "base");
    const linked = join(temp("prim-driver-wt-"), "wt");
    git(root, "worktree", "add", "-q", "-b", "linked", linked);
    const earlier = Date.now() - 10_000;
    recordHooksWired(root, { now: earlier });
    recordHooksWired(linked, { now: earlier });

    commitAndRunDriver(root, "in main");
    // In a linked worktree Git exports GIT_DIR to its hooks.
    commitAndRunDriver(linked, "in linked worktree", {
      GIT_DIR: git(linked, "rev-parse", "--absolute-git-dir"),
    });

    const later = Date.now() + POST_COMMIT_GRACE_MS * 2;
    expect(inspectPostCommitFiring(root, later)).toMatchObject({ state: "fired" });
    expect(inspectPostCommitFiring(linked, later)).toMatchObject({ state: "fired" });
  });
});
