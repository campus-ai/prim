import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST_COMMIT_GRACE_MS,
  inspectPostCommitFiring,
  latestLocalCommitAt,
  recordHooksWired,
  recordPostCommitFired,
} from "./commit-heartbeat.js";

const roots: string[] = [];

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(options: { active?: boolean } = {}): string {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), "prim-heartbeat-")));
  roots.push(root);
  git(root, "init", "-q");
  git(root, "config", "user.name", "Prim Test");
  git(root, "config", "user.email", "prim@example.test");
  git(root, "config", "commit.gpgsign", "false");
  if (options.active !== false) git(root, "config", "prim.active", "true");
  return root;
}

function commit(root: string, message: string): void {
  git(root, "commit", "-q", "--allow-empty", "-m", message);
}

const later = () => Date.now() + POST_COMMIT_GRACE_MS * 2;

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("post-commit firing evidence", () => {
  it("expects nothing in an inactive repository", () => {
    const root = repository({ active: false });
    recordHooksWired(root, Date.now() - 10_000);
    commit(root, "one");
    expect(inspectPostCommitFiring(root, later())).toEqual({ state: "inactive" });
  });

  it("is unverified before any local commit", () => {
    const root = repository();
    recordHooksWired(root);
    expect(inspectPostCommitFiring(root, later())).toEqual({ state: "unverified" });
  });

  it("fails a commit made after wiring that never reached prim", () => {
    const root = repository();
    recordHooksWired(root, Date.now() - 10_000);
    commit(root, "one");
    expect(inspectPostCommitFiring(root, later())).toMatchObject({ state: "not_firing" });
    expect(inspectPostCommitFiring(root, later())).not.toHaveProperty("firedAt");
  });

  it("passes when post-commit reached prim for the latest commit", () => {
    const root = repository();
    recordHooksWired(root, Date.now() - 10_000);
    commit(root, "one");
    recordPostCommitFired(root, git(root, "rev-parse", "HEAD"));
    expect(inspectPostCommitFiring(root, later())).toMatchObject({ state: "fired" });
  });

  it("fails when the hook ran before but stopped reaching prim", () => {
    const root = repository();
    const firedAt = Date.now() - 30_000;
    recordPostCommitFired(root, undefined, firedAt);
    commit(root, "one");
    expect(inspectPostCommitFiring(root, later())).toEqual({
      state: "not_firing",
      commitAt: expect.any(Number),
      firedAt,
    });
  });

  it("holds judgment while the detached driver may still be starting", () => {
    const root = repository();
    recordHooksWired(root, Date.now() - 10_000);
    commit(root, "one");
    expect(inspectPostCommitFiring(root, Date.now())).toMatchObject({ state: "pending" });
  });

  it("does not judge commits made before the hooks were wired", () => {
    const root = repository();
    commit(root, "one");
    recordHooksWired(root, Date.now() + 5_000);
    expect(inspectPostCommitFiring(root, later())).toEqual({ state: "unverified" });
  });

  it("counts an amend as a commit but not a checkout or reset", () => {
    const root = repository();
    commit(root, "one");
    const firstAt = latestLocalCommitAt(root);
    git(root, "checkout", "-q", "-b", "feature");
    git(root, "reset", "-q", "HEAD");
    expect(latestLocalCommitAt(root)).toBe(firstAt);

    recordHooksWired(root, Date.now() - 10_000);
    git(root, "commit", "-q", "--amend", "--allow-empty", "-m", "amended");
    expect(inspectPostCommitFiring(root, later())).toMatchObject({ state: "not_firing" });
  });

  it("keeps evidence per worktree, like the reflog it is checked against", () => {
    const root = repository();
    commit(root, "one");
    const linked = join(
      realpathSync.native(mkdtempSync(join(tmpdir(), "prim-heartbeat-wt-"))),
      "wt",
    );
    roots.push(join(linked, ".."));
    git(root, "worktree", "add", "-q", "-b", "linked", linked);
    recordHooksWired(root, Date.now() - 10_000);
    recordHooksWired(linked, Date.now() - 10_000);
    commit(linked, "in linked worktree");
    recordPostCommitFired(linked, git(linked, "rev-parse", "HEAD"));
    commit(root, "in main worktree");

    expect(inspectPostCommitFiring(linked, later())).toMatchObject({ state: "fired" });
    expect(inspectPostCommitFiring(root, later())).toMatchObject({ state: "not_firing" });
  });

  it("never throws from a hook outside Git", () => {
    const outside = realpathSync.native(mkdtempSync(join(tmpdir(), "prim-heartbeat-out-")));
    roots.push(outside);
    expect(() => recordPostCommitFired(outside, "a".repeat(40))).not.toThrow();
    expect(() => recordHooksWired(outside)).not.toThrow();
  });
});
