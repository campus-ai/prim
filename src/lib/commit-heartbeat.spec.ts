import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POST_COMMIT_GRACE_MS,
  inspectPostCommitFiring,
  latestLocalCommit,
  recordHooksWired,
  recordPostCommitFired,
} from "./commit-heartbeat.js";
import { stageFakeGitHookRuntime } from "./git-hook-runtime.testing.js";
import { ensureEffectiveGitHook } from "./git-hooks.js";

const roots: string[] = [];

function temp(prefix: string): string {
  const path = realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));
  roots.push(path);
  return path;
}

function git(cwd: string, args: string[], env: NodeJS.ProcessEnv = process.env): string {
  return execFileSync("git", args, {
    cwd,
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function repository(options: { active?: boolean } = {}): string {
  const root = temp("prim-heartbeat-");
  git(root, ["init", "-q"]);
  git(root, ["config", "user.name", "Prim Test"]);
  git(root, ["config", "user.email", "prim@example.test"]);
  git(root, ["config", "commit.gpgsign", "false"]);
  if (options.active !== false) git(root, ["config", "prim.active", "true"]);
  return root;
}

function commit(root: string, message: string, env?: NodeJS.ProcessEnv): string {
  git(root, ["commit", "-q", "--allow-empty", "-m", message], env);
  return git(root, ["rev-parse", "HEAD"]);
}

const later = () => Date.now() + POST_COMMIT_GRACE_MS * 2;
const wiredEarlier = (root: string) => recordHooksWired(root, { now: Date.now() - 10_000 });

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
    wiredEarlier(root);
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
    wiredEarlier(root);
    commit(root, "one");
    expect(inspectPostCommitFiring(root, later())).toEqual({
      state: "not_firing",
      commitAt: expect.any(Number),
    });
  });

  it("passes when post-commit reached prim for that exact commit", () => {
    const root = repository();
    wiredEarlier(root);
    recordPostCommitFired(root, commit(root, "one"));
    expect(inspectPostCommitFiring(root, later())).toMatchObject({ state: "fired" });
  });

  it("matches by SHA, so a run for one commit never vouches for the next", () => {
    const root = repository();
    wiredEarlier(root);
    recordPostCommitFired(root, commit(root, "one"));
    commit(root, "two, seconds later, never reached prim");
    expect(inspectPostCommitFiring(root, later())).toMatchObject({
      state: "not_firing",
      firedAt: expect.any(Number),
    });
  });

  it("is not fooled by a committer date in the future", () => {
    const root = repository();
    wiredEarlier(root);
    const future = new Date(Date.now() + 3_600_000).toISOString();
    const sha = commit(root, "dated", { ...process.env, GIT_COMMITTER_DATE: future });
    recordPostCommitFired(root, sha);
    expect(inspectPostCommitFiring(root, later())).toMatchObject({ state: "fired" });
  });

  it("holds judgment while the detached driver may still be starting", () => {
    const root = repository();
    wiredEarlier(root);
    commit(root, "one");
    expect(inspectPostCommitFiring(root, Date.now())).toMatchObject({ state: "pending" });
  });

  it("does not judge commits made before the hooks were wired", () => {
    const root = repository();
    commit(root, "one");
    recordHooksWired(root, { now: Date.now() + 5_000 });
    expect(inspectPostCommitFiring(root, later())).toEqual({ state: "unverified" });
  });

  it("keeps an existing expectation when asked to record only if absent", () => {
    const root = repository();
    wiredEarlier(root);
    commit(root, "one");
    recordHooksWired(root, { onlyIfAbsent: true });
    expect(inspectPostCommitFiring(root, later()).state).toBe("not_firing");
  });

  it("counts git commit, including amend, but not a checkout or reset", () => {
    const root = repository();
    const first = commit(root, "one");
    git(root, ["checkout", "-q", "-b", "feature"]);
    git(root, ["reset", "-q", "HEAD"]);
    expect(latestLocalCommit(root)?.sha).toBe(first);
    git(root, ["commit", "-q", "--amend", "--allow-empty", "-m", "amended"]);
    expect(latestLocalCommit(root)?.sha).toBe(git(root, ["rev-parse", "HEAD"]));
  });

  it("keeps a bounded, private set of stamps", () => {
    const root = repository();
    const shas = Array.from({ length: 40 }, (_, index) => index.toString(16).padStart(40, "a"));
    shas.forEach((sha, index) => recordPostCommitFired(root, sha, Date.now() + index));
    const dir = join(root, ".git", "prim", "post-commit-fired");
    expect(readdirSync(dir)).toHaveLength(32);
    expect(statSync(join(root, ".git", "prim")).mode & 0o777).toBe(0o700);
    expect(statSync(join(dir, shas[39] as string)).mode & 0o777).toBe(0o600);
  });

  it("never throws from a hook outside Git", () => {
    const outside = temp("prim-heartbeat-out-");
    expect(() => recordPostCommitFired(outside, "a".repeat(40))).not.toThrow();
    expect(() => recordHooksWired(outside)).not.toThrow();
  });
});

describe("post-commit firing evidence through a real hook", () => {
  it("records where doctor looks, from the main checkout and a linked worktree", async () => {
    const root = repository();
    const config = temp("prim-heartbeat-config-");
    const seen = join(temp("prim-heartbeat-seen-"), "runs");
    vi.stubEnv("PRIM_CONFIG_DIR", config);
    // The driver's view of the world, exactly as Git hands it to post-commit.
    stageFakeGitHookRuntime(config, {
      "prim-post-commit": `printf '%s\\t%s\\n' "$(pwd)" "$PRIM_COMMIT_SHA" >> '${seen}'\n`,
    });
    commit(root, "base");
    const linked = join(temp("prim-heartbeat-wt-"), "wt");
    git(root, ["worktree", "add", "-q", "-b", "linked", linked]);
    ensureEffectiveGitHook("post-commit", root);
    wiredEarlier(root);
    wiredEarlier(linked);

    commit(root, "in main");
    commit(linked, "in linked worktree");
    await vi.waitFor(
      () =>
        expect(existsSync(seen) && readFileSync(seen, "utf8").trim().split("\n")).toHaveLength(2),
      { timeout: 10_000, interval: 50 },
    );
    for (const line of readFileSync(seen, "utf8").trim().split("\n")) {
      const [cwd, sha] = line.split("\t") as [string, string];
      recordPostCommitFired(cwd, sha);
    }

    expect(inspectPostCommitFiring(root, later())).toMatchObject({ state: "fired" });
    expect(inspectPostCommitFiring(linked, later())).toMatchObject({ state: "fired" });
  });
});
