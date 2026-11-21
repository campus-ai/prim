import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  diagnose: vi.fn(),
  cloud: vi.fn(),
}));

vi.mock("../client.js", () => ({
  getSiteUrl: () => "https://api.example.com",
  isSessionEnded: () => false,
}));
vi.mock("../commands/claude-plugin.js", () => ({
  refreshClaudePlugins: async () => ({ installed: 0, refreshed: 0 }),
}));
vi.mock("../commands/skill.js", () => ({
  hasUsableCodexGuidance: () => false,
  hasUsableCursorSkill: () => false,
}));
vi.mock("../daemon/client.js", () => ({ daemonRequest: async () => undefined }));
vi.mock("../daemon/self-heal.js", () => ({ kickDaemonEnsure: () => undefined }));
vi.mock("../lib/activation.js", () => ({
  isRepoActiveForCapture: () => true,
  repoActiveFlag: () => "true",
  setRepoActive: () => undefined,
}));
vi.mock("../lib/bin-cache.js", () => ({ warmBinCache: () => undefined }));
vi.mock("../lib/cloud-session.js", () => ({
  diagnoseCloudSession: mocks.diagnose,
  isClaudeCloudSession: mocks.cloud,
}));
vi.mock("../lib/collect-scope.js", () => ({ fetchAndCacheCollectScope: async () => undefined }));
vi.mock("../lib/commit-heartbeat.js", () => ({
  clearHooksWired: () => undefined,
  recordHooksWired: () => undefined,
}));
vi.mock("../lib/git-hooks.js", () => ({
  MANAGED_GIT_HOOK_NAMES: ["post-commit"],
  ensureEffectiveGitHook: () => ({ outcome: "unchanged" }),
}));
vi.mock("../lib/git.js", () => ({ gitToplevel: () => "/repo" }));
vi.mock("../lib/repository-binding.js", () => ({ bindRepository: mocks.bind }));
vi.mock("../lib/workspace-id.js", () => ({
  getOrCreateWorkspaceId: () => ({ status: "not_git" }),
}));

import { processSessionStart } from "./session-start-core.js";

const NOTICE = "Primitive is not connected in this Claude Code cloud session: test.";
const envelope = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "session-1",
  cwd: "/repo",
});

type Output = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };

beforeEach(() => {
  mocks.diagnose.mockResolvedValue(NOTICE);
  mocks.bind.mockRejectedValue(new Error("fetch failed"));
  mocks.cloud.mockReturnValue(true);
});
afterEach(() => vi.clearAllMocks());

describe("processSessionStart in a Claude Code cloud session", () => {
  it("tells the user and the agent why an active repository could not connect", async () => {
    const { output } = await processSessionStart(envelope, "claude_code");
    const result = output as Output;
    expect(result.systemMessage).toBe(NOTICE);
    expect(result.hookSpecificOutput?.additionalContext).toContain(NOTICE);
  });

  it("stays silent outside a cloud session", async () => {
    mocks.cloud.mockReturnValue(false);
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).systemMessage).toBeUndefined();
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it("does not diagnose a repository that connected", async () => {
    mocks.bind.mockResolvedValue({
      status: "connected",
      repoSyncId: "sync",
      repositoryFullName: "campus-ai/prim",
    });
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).systemMessage).toBeUndefined();
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it("stays fail-soft when the diagnosis itself throws", async () => {
    mocks.diagnose.mockRejectedValue(new Error("boom"));
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).systemMessage).toBeUndefined();
  });
});
