import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSiteUrl, isSessionEnded } from "../client.js";
import { refreshClaudePlugins } from "../commands/claude-plugin.js";
import { loadSkill } from "../commands/skill.js";
import { daemonRequest } from "../daemon/client.js";
import {
  acknowledgeDecisionFeedback,
  leaseDecisionFeedback,
  renderFeedback,
} from "../decisions/feedback.js";
import { isRepoActiveForCapture } from "../lib/activation.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import { PRIM_SKILL_REMINDER, processSessionStart } from "./session-start-core.js";

// Impure collaborators (network, daemon socket, fs, git) are module-mocked as
// in the sibling hook specs; pure shaping (normalizeEnvelope,
// reauthNoticeFields, buildHookOutput) runs real so the composed output is
// what's pinned here.
vi.mock("../client.js", () => ({ getSiteUrl: vi.fn(), isSessionEnded: vi.fn() }));
vi.mock("../commands/claude-plugin.js", () => ({ refreshClaudePlugins: vi.fn() }));
vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn() }));
vi.mock("../daemon/self-heal.js", () => ({ kickDaemonEnsure: vi.fn() }));
vi.mock("../decisions/feedback.js", () => ({
  FEEDBACK_DEADLINE_MS: 3_000,
  acknowledgeDecisionFeedback: vi.fn(),
  leaseDecisionFeedback: vi.fn(),
  renderFeedback: vi.fn(),
}));
vi.mock("../lib/activation.js", () => ({ isRepoActiveForCapture: vi.fn() }));
vi.mock("../lib/workspace-id.js", () => ({ getOrCreateWorkspaceId: vi.fn() }));

const ENVELOPE = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "session-1",
  cwd: "/repo",
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSiteUrl).mockReturnValue("https://app.getprimitive.ai");
  vi.mocked(isSessionEnded).mockReturnValue(false);
  vi.mocked(refreshClaudePlugins).mockReturnValue({ installed: 0, refreshed: 0 });
  vi.mocked(daemonRequest).mockResolvedValue(null);
  vi.mocked(leaseDecisionFeedback).mockResolvedValue(undefined);
  vi.mocked(isRepoActiveForCapture).mockReturnValue(false);
  vi.mocked(getOrCreateWorkspaceId).mockReturnValue({ status: "not_git" });
});

describe("processSessionStart", () => {
  it("keeps the reminder taxonomy in lockstep with the SKILL.md trigger", () => {
    const sharedPhrases = [
      "between plausible approaches",
      "a lasting goal, priority, constraint, invariant, default, commitment, tradeoff, exception, or shared instruction",
    ];
    for (const phrase of sharedPhrases) {
      expect(PRIM_SKILL_REMINDER).toContain(phrase);
      expect(loadSkill()).toContain(phrase);
    }
  });

  it("injects the proactive reminder in an active repo with a recognized skill", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(refreshClaudePlugins).mockReturnValue({ installed: 1, refreshed: 0 });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: PRIM_SKILL_REMINDER,
      },
    });
  });

  it("requests a same-session skill reload after refresh, even in an inactive repo", async () => {
    vi.mocked(refreshClaudePlugins).mockReturnValue({ installed: 1, refreshed: 1 });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true },
    });
  });

  it("emits neither reminder nor reload when no recognized skill is installed", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({});
  });

  it("coexists with decision feedback and wires acknowledgment to the lease", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(refreshClaudePlugins).mockReturnValue({ installed: 1, refreshed: 1 });
    vi.mocked(getOrCreateWorkspaceId).mockReturnValue({
      status: "ready",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      path: "/repo/.git/prim/workspace-id",
      created: false,
    });
    vi.mocked(leaseDecisionFeedback).mockResolvedValue({ events: [], hasMore: false });
    vi.mocked(renderFeedback).mockReturnValue({
      systemMessage: "feedback",
      deliveries: [{ eventId: "event-1", leaseVersion: 1 }],
    });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({
      systemMessage: "feedback",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: PRIM_SKILL_REMINDER,
        reloadSkills: true,
      },
    });
    expect(acknowledgeDecisionFeedback).not.toHaveBeenCalled();
    await result.acknowledge?.();
    expect(acknowledgeDecisionFeedback).toHaveBeenCalledOnce();
    expect(acknowledgeDecisionFeedback).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      deliveries: [{ eventId: "event-1", leaseVersion: 1 }],
      signal: expect.any(AbortSignal),
    });
  });

  it("keeps a terminal auth notice as the only human-facing message while reloading", async () => {
    vi.mocked(isSessionEnded).mockReturnValue(true);
    vi.mocked(refreshClaudePlugins).mockReturnValue({ installed: 1, refreshed: 1 });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output.systemMessage).toContain("prim auth login");
    expect(result.output.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      reloadSkills: true,
    });
  });

  it("leaves Codex presence behavior unchanged and never refreshes Claude skills", async () => {
    vi.mocked(daemonRequest).mockImplementation(async (method) =>
      method === "status_snapshot" ? { onlineCount: 3, presenceStale: false } : null,
    );

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "[prim] team: 3 online",
      },
    });
    expect(refreshClaudePlugins).not.toHaveBeenCalled();
  });

  it("leaves invalid hook envelopes unchanged without attempting refresh", async () => {
    const result = await processSessionStart("not json", "claude_code");

    expect(result.output).toEqual({});
    expect(refreshClaudePlugins).not.toHaveBeenCalled();
  });
});
