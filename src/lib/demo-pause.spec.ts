import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkDemoPause } from "../commands/doctor.js";
import { isRepoActiveForCapture } from "./activation.js";
import {
  DEMO_PAUSE_MS,
  clearDemoPause,
  endDemoPause,
  extendDemoPause,
  pauseCaptureForDemo,
  readDemoPause,
} from "./demo-pause.js";

let work: string;
let repo: string;
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
const local = (cwd = repo) => {
  try {
    return git(cwd, "config", "--local", "--get", "prim.active").trim();
  } catch {
    return undefined;
  }
};

beforeEach(() => {
  work = realpathSync(mkdtempSync(join(tmpdir(), "prim-pause-")));
  repo = join(work, "repo");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(work, "gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  execFileSync("git", ["init", "-q", repo]);
});

afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

describe("demo capture pause", () => {
  it("pauses, ends, and lifts at the user's next prompt", () => {
    git(repo, "config", "--local", "prim.active", "true");
    pauseCaptureForDemo(repo, "run-1");
    expect(local()).toBe("false");
    expect(isRepoActiveForCapture(repo, { userPrompt: true })).toBe(false);
    endDemoPause(repo, "run-2");
    expect(readDemoPause(repo)?.ending).toBe(false);
    endDemoPause(repo, "run-1");
    // The demo's own tool call and reply stay paused; only a prompt lifts it.
    expect(isRepoActiveForCapture(repo)).toBe(false);
    expect(isRepoActiveForCapture(repo, { userPrompt: true })).toBe(true);
    expect(local()).toBe("true");
    expect(readDemoPause(repo)).toBeUndefined();
  });

  it("restores an unset local flag, so a global activation applies again", () => {
    git(repo, "config", "--global", "prim.active", "true");
    pauseCaptureForDemo(repo, "run-1");
    expect(isRepoActiveForCapture(repo)).toBe(false);
    endDemoPause(repo, "run-1");
    expect(isRepoActiveForCapture(repo, { userPrompt: true })).toBe(true);
    expect(local()).toBeUndefined();
  });

  it("keeps the original value when a newer run replaces a pause", () => {
    git(repo, "config", "--local", "prim.active", "true");
    pauseCaptureForDemo(repo, "run-1");
    pauseCaptureForDemo(repo, "run-2");
    expect(readDemoPause(repo)).toMatchObject({ runId: "run-2", previous: "true" });
  });

  it("expires unless a step extends it, and heals from any worktree", () => {
    git(repo, "config", "--local", "prim.active", "true");
    // CI runners have no git identity; a worktree needs a commit.
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "init",
    );
    const tree = join(work, "tree");
    git(repo, "worktree", "add", "-q", tree);
    const now = Date.now();
    pauseCaptureForDemo(tree, "run-1", now);
    expect(local(repo)).toBe("false");
    extendDemoPause(tree, "run-1", now + DEMO_PAUSE_MS - 1);
    expect(checkDemoPause(repo, now + DEMO_PAUSE_MS)).toEqual([
      expect.objectContaining({ name: "demo-pause", status: "warn" }),
    ]);
    git(repo, "worktree", "remove", tree);
    expect(checkDemoPause(repo, now + 2 * DEMO_PAUSE_MS)).toEqual([]);
    expect(local(repo)).toBe("true");
  });

  it("never overrides an explicit disable", () => {
    git(repo, "config", "--local", "prim.active", "true");
    pauseCaptureForDemo(repo, "run-1");
    // What `prim disable` does: clear the pause, then set the flag.
    clearDemoPause(repo);
    git(repo, "config", "--local", "prim.active", "false");
    endDemoPause(repo, "run-1");
    expect(isRepoActiveForCapture(repo, { userPrompt: true })).toBe(false);
    expect(local()).toBe("false");
  });

  it("treats an unreadable record as expired and restores unset", () => {
    git(repo, "config", "--local", "prim.active", "false");
    git(repo, "config", "--local", "prim.demoPause", "garbage");
    expect(isRepoActiveForCapture(repo)).toBe(false);
    expect(local()).toBeUndefined();
    expect(readDemoPause(repo)).toBeUndefined();
  });
});
