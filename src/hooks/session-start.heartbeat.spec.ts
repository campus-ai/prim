import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getSiteUrl, isSessionEnded } from "../client.js";
import { refreshClaudePlugins } from "../commands/claude-plugin.js";
import { daemonRequest } from "../daemon/client.js";
import { leaseDecisionFeedback } from "../decisions/feedback.js";
import { fetchAndCacheCollectScope } from "../lib/collect-scope.js";
import { POST_COMMIT_GRACE_MS, inspectPostCommitFiring } from "../lib/commit-heartbeat.js";
import { stageFakeGitHookRuntime } from "../lib/git-hook-runtime.testing.js";
import { bindRepository } from "../lib/repository-binding.js";
import { processSessionStart } from "./session-start-core.js";

// Real Git, real activation, hook wiring, and evidence; only the network,
// daemon, and agent-integration collaborators are mocked.
vi.mock("../client.js", () => ({
  getClient: vi.fn(() => ({
    get: vi.fn().mockRejectedValue(new Error("offline")),
    post: vi.fn(),
  })),
  getSiteUrl: vi.fn(),
  isSessionEnded: vi.fn(),
}));
vi.mock("../commands/claude-plugin.js", () => ({ refreshClaudePlugins: vi.fn() }));
vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn() }));
vi.mock("../daemon/self-heal.js", () => ({ kickDaemonEnsure: vi.fn() }));
vi.mock("../decisions/feedback.js", () => ({
  FEEDBACK_DEADLINE_MS: 3_000,
  acknowledgeDecisionFeedback: vi.fn(),
  leaseDecisionFeedback: vi.fn(),
  renderFeedback: vi.fn(),
}));
vi.mock("../lib/collect-scope.js", () => ({ fetchAndCacheCollectScope: vi.fn() }));
vi.mock("../lib/repository-binding.js", () => ({
  bindRepository: vi.fn(),
  resolveRepositoryBinding: vi.fn(),
}));
vi.mock("../lib/workspace-id.js", () => ({ getOrCreateWorkspaceId: vi.fn() }));

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

function sessionStart(root: string): Promise<unknown> {
  return processSessionStart(
    JSON.stringify({ hook_event_name: "SessionStart", session_id: "s", cwd: root }),
    "claude",
  );
}

/** A commit Git dates `seconds` from now, so it orders cleanly against stamps. */
function commitAt(root: string, message: string, seconds: number): void {
  const date = new Date(Date.now() + seconds * 1_000).toISOString();
  git(root, ["commit", "-q", "--allow-empty", "-m", message], {
    ...process.env,
    GIT_COMMITTER_DATE: date,
  });
}

beforeEach(() => {
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
  vi.stubEnv("HOME", temp("prim-session-home-"));
  const config = temp("prim-session-config-");
  vi.stubEnv("PRIM_CONFIG_DIR", config);
  // A runtime with no post-commit entry: the hook runs, prim never sees it.
  stageFakeGitHookRuntime(config);
  vi.mocked(getSiteUrl).mockReturnValue("https://app.getprimitive.ai");
  vi.mocked(isSessionEnded).mockReturnValue(false);
  vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 0, refreshed: 0 });
  vi.mocked(daemonRequest).mockResolvedValue(null);
  vi.mocked(leaseDecisionFeedback).mockResolvedValue(undefined);
  vi.mocked(fetchAndCacheCollectScope).mockResolvedValue({ kind: "unfetched" });
  vi.mocked(bindRepository).mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("prim turned off with raw git config", () => {
  it("never fails commits made while off, once a session has seen it off", async () => {
    const root = temp("prim-session-raw-");
    git(root, ["init", "-q"]);
    git(root, ["config", "user.name", "Prim Test"]);
    git(root, ["config", "user.email", "prim@example.test"]);
    git(root, ["config", "commit.gpgsign", "false"]);
    git(root, ["config", "prim.active", "true"]);
    const wired = join(root, ".git", "prim", "git-hooks-wired");

    await sessionStart(root);
    expect(existsSync(wired)).toBe(true);

    git(root, ["config", "prim.active", "false"]); // not `prim disable`
    await sessionStart(root);
    expect(existsSync(wired)).toBe(false);
    commitAt(root, "while off", 5);
    git(root, ["config", "prim.active", "true"]); // not `prim enable`

    const later = Date.now() + POST_COMMIT_GRACE_MS * 2;
    expect(inspectPostCommitFiring(root, later + 5_000)).toEqual({ state: "unverified" });

    // The next active session starts a new expectation, judged from then on.
    await sessionStart(root);
    expect(existsSync(wired)).toBe(true);
    commitAt(root, "while on, never reaching prim", 10);
    expect(inspectPostCommitFiring(root, later + 10_000)).toMatchObject({ state: "not_firing" });
  });
});
