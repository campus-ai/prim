import { beforeEach, describe, expect, it, vi } from "vitest";
import { getSiteUrl, isSessionEnded } from "../client.js";
import { refreshClaudePlugins } from "../commands/claude-plugin.js";
import { hasUsableCodexGuidance, loadSkill } from "../commands/skill.js";
import { daemonRequest } from "../daemon/client.js";
import { kickDaemonEnsure } from "../daemon/self-heal.js";
import {
  acknowledgeDecisionFeedback,
  leaseDecisionFeedback,
  renderFeedback,
} from "../decisions/feedback.js";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { gitToplevel } from "../lib/git.js";
import { bindRepository } from "../lib/repository-binding.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import { REAUTH_NOTICE } from "./reauth-notice.js";
import {
  CODEX_PRIM_REMINDER,
  PRIM_SKILL_REMINDER,
  processSessionStart,
} from "./session-start-core.js";

// Impure collaborators (network, daemon socket, fs, git) are module-mocked as
// in the sibling hook specs; pure shaping (normalizeEnvelope,
// reauthNoticeFields, buildHookOutput) runs real so the composed output is
// what's pinned here.
vi.mock("../client.js", () => ({ getSiteUrl: vi.fn(), isSessionEnded: vi.fn() }));
vi.mock("../commands/claude-plugin.js", () => ({ refreshClaudePlugins: vi.fn() }));
vi.mock("../commands/skill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../commands/skill.js")>();
  return { ...actual, hasUsableCodexGuidance: vi.fn() };
});
vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn() }));
vi.mock("../daemon/self-heal.js", () => ({ kickDaemonEnsure: vi.fn() }));
vi.mock("../decisions/feedback.js", () => ({
  FEEDBACK_DEADLINE_MS: 3_000,
  acknowledgeDecisionFeedback: vi.fn(),
  leaseDecisionFeedback: vi.fn(),
  renderFeedback: vi.fn(),
}));
vi.mock("../lib/activation.js", () => ({
  isRepoActiveForCapture: vi.fn(),
  repoSyncId: vi.fn(),
}));
vi.mock("../lib/git.js", () => ({ gitToplevel: vi.fn() }));
vi.mock("../lib/repository-binding.js", () => ({ bindRepository: vi.fn() }));
vi.mock("../lib/workspace-id.js", () => ({ getOrCreateWorkspaceId: vi.fn() }));

const ENVELOPE = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "session-1",
  cwd: "/repo",
});

const EXPECTED_CLAUDE_REMINDER =
  "Primitive is active in this repository. When this task chooses between plausible approaches or establishes or changes a lasting goal, priority, constraint, invariant, default, commitment, tradeoff, exception, or shared instruction, invoke the `prim` skill before finishing. Never invoke `prim` for routine implementation that merely follows an existing decision made before this task or for temporary tactics; they never qualify, including for evaluation. When a direct request replaces one lasting default with another but supplies no rationale, complete the work, invoke the skill, and ask one concise rationale question at the task boundary, even if the user requested only implementation or recording fails.";
const EXPECTED_CODEX_REMINDER =
  "Primitive is active in this repository. When this task chooses between plausible approaches or establishes or changes a lasting goal, priority, constraint, invariant, default, commitment, tradeoff, exception, or shared instruction, follow the installed Prim workflow and use the `prim` CLI before finishing. Never invoke `prim` for routine implementation that merely follows an existing decision made before this task or for temporary tactics; they never qualify, including for evaluation. When a direct request replaces one lasting default with another but supplies no rationale, complete the work, follow the installed Prim workflow and use the `prim` CLI, and ask one concise rationale question at the task boundary, even if the user requested only implementation or recording fails.";

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getSiteUrl).mockReturnValue("https://app.getprimitive.ai");
  vi.mocked(isSessionEnded).mockReturnValue(false);
  vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 0, refreshed: 0 });
  vi.mocked(daemonRequest).mockResolvedValue(null);
  vi.mocked(leaseDecisionFeedback).mockResolvedValue(undefined);
  vi.mocked(isRepoActiveForCapture).mockReturnValue(false);
  vi.mocked(repoSyncId).mockReturnValue("sync-existing");
  vi.mocked(hasUsableCodexGuidance).mockReturnValue(false);
  vi.mocked(gitToplevel).mockReturnValue("/repo");
  vi.mocked(getOrCreateWorkspaceId).mockReturnValue({ status: "not_git" });
});

describe("processSessionStart", () => {
  it("keeps the reminder taxonomy in lockstep with the SKILL.md trigger", () => {
    const frontmatter = loadSkill().split("---", 3)[1] ?? "";
    const description = /^description:\s*(.+)$/mu.exec(frontmatter)?.[1] ?? "";
    const sharedPhrases = [
      "between plausible approaches",
      "a lasting goal, priority, constraint, invariant, default, commitment, tradeoff, exception, or shared instruction",
      "routine implementation that merely follows an existing decision",
      "temporary tactics",
    ];
    for (const phrase of sharedPhrases) {
      for (const reminder of [PRIM_SKILL_REMINDER, CODEX_PRIM_REMINDER]) {
        expect(reminder).toContain(phrase);
      }
      expect(description).toContain(phrase);
    }
  });

  it("pins the complete Claude and Codex reminders independently", () => {
    expect(PRIM_SKILL_REMINDER).toBe(EXPECTED_CLAUDE_REMINDER);
    expect(CODEX_PRIM_REMINDER).toBe(EXPECTED_CODEX_REMINDER);
    expect(CODEX_PRIM_REMINDER).not.toContain("invoke the skill");
  });

  it("pins exclusion precedence and the missing-rationale question boundary", () => {
    for (const reminder of [PRIM_SKILL_REMINDER, CODEX_PRIM_REMINDER]) {
      expect(reminder).toContain("Never invoke `prim` for routine implementation");
      expect(reminder).toContain("they never qualify, including for evaluation");
      expect(reminder).toContain("replaces one lasting default with another");
      expect(reminder).toContain("supplies no rationale");
      expect(reminder).toContain("one concise rationale question");
      expect(reminder).toContain("at the task boundary");
      expect(reminder).toContain("requested only implementation or recording fails");
    }
  });

  it("injects the proactive reminder in an active repo with a recognized skill", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 1, refreshed: 0 });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: PRIM_SKILL_REMINDER,
      },
    });
    expect(isRepoActiveForCapture).toHaveBeenCalledWith("/repo");
    expect(gitToplevel).toHaveBeenCalledWith("/repo");
    expect(refreshClaudePlugins).toHaveBeenCalledWith("/repo", {
      includeProject: true,
      projectRoot: "/repo",
    });
    expect(getOrCreateWorkspaceId).toHaveBeenCalledWith("/repo");
    expect(kickDaemonEnsure).toHaveBeenCalledOnce();
    expect(daemonRequest).toHaveBeenCalledWith(
      "session_start",
      { sessionId: "session-1" },
      { timeoutMs: 250 },
    );
    const kickOrder = vi.mocked(kickDaemonEnsure).mock.invocationCallOrder[0];
    const daemonOrder = vi.mocked(daemonRequest).mock.invocationCallOrder[0];
    const refreshOrder = vi.mocked(refreshClaudePlugins).mock.invocationCallOrder[0];
    expect(kickOrder).toBeLessThan(daemonOrder);
    expect(daemonOrder).toBeLessThan(refreshOrder);
  });

  it("silently binds an active repository once before agent-specific work", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(repoSyncId).mockReturnValue(undefined);

    const feedbackSignal = AbortSignal.timeout(3_000);
    await processSessionStart(ENVELOPE, "claude_code", feedbackSignal);

    expect(bindRepository).toHaveBeenCalledOnce();
    const options = vi.mocked(bindRepository).mock.calls[0]?.[1];
    expect(options).toMatchObject({ quietRefresh: true });
    expect(options?.signal).toBeInstanceOf(AbortSignal);
    expect(options?.signal).not.toBe(feedbackSignal);
  });

  it("preserves normal output when opportunistic binding fails", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(repoSyncId).mockReturnValue(undefined);
    vi.mocked(bindRepository).mockRejectedValue(new Error("offline"));
    vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 1, refreshed: 0 });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output.hookSpecificOutput?.additionalContext).toBe(PRIM_SKILL_REMINDER);
  });

  it("bounds an unavailable bind without spending the Decision feedback signal", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(repoSyncId).mockReturnValue(undefined);
    vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 1, refreshed: 0 });
    vi.mocked(getOrCreateWorkspaceId).mockReturnValue({
      status: "ready",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      path: "/repo/.git/prim/workspace-id",
      created: false,
    });
    vi.mocked(bindRepository).mockImplementation(
      async (_root, options) =>
        await new Promise((_, reject) => {
          options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
            once: true,
          });
        }),
    );

    await processSessionStart(ENVELOPE, "claude_code");

    const feedback = vi.mocked(leaseDecisionFeedback).mock.calls[0]?.[0].signal;
    expect(feedback).toBeInstanceOf(AbortSignal);
    expect(feedback?.aborted).toBe(false);
  });

  it("refreshes only user scope and requests a reload in an inactive repo", async () => {
    vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 1, refreshed: 1 });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({
      hookSpecificOutput: { hookEventName: "SessionStart", reloadSkills: true },
    });
    expect(refreshClaudePlugins).toHaveBeenCalledWith("/repo", { includeProject: false });
  });

  it("never treats a non-repository cwd as active even when global activation is true", async () => {
    vi.mocked(gitToplevel).mockReturnValue(null);
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 1, refreshed: 0 });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({});
    expect(isRepoActiveForCapture).not.toHaveBeenCalled();
    expect(refreshClaudePlugins).toHaveBeenCalledWith("/repo", { includeProject: false });
    expect(getOrCreateWorkspaceId).not.toHaveBeenCalled();
    expect(leaseDecisionFeedback).not.toHaveBeenCalled();
  });

  it("emits neither reminder nor reload when no recognized skill is installed", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({});
  });

  it("coexists with decision feedback and wires acknowledgment to the lease", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 1, refreshed: 1 });
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

    const feedbackSignal = AbortSignal.timeout(3_000);
    const result = await processSessionStart(ENVELOPE, "claude_code", feedbackSignal);

    expect(result.output).toEqual({
      systemMessage: "feedback",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: PRIM_SKILL_REMINDER,
        reloadSkills: true,
      },
    });
    expect(leaseDecisionFeedback).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      currentSessionId: "session-1",
      signal: feedbackSignal,
    });
    expect(acknowledgeDecisionFeedback).not.toHaveBeenCalled();
    await result.acknowledge?.();
    expect(acknowledgeDecisionFeedback).toHaveBeenCalledOnce();
    expect(acknowledgeDecisionFeedback).toHaveBeenCalledWith({
      workspaceId: "00000000-0000-4000-8000-000000000001",
      deliveries: [{ eventId: "event-1", leaseVersion: 1 }],
      signal: feedbackSignal,
    });
  });

  it("keeps the reminder and reload when a ready workspace has no feedback", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 1, refreshed: 1 });
    vi.mocked(getOrCreateWorkspaceId).mockReturnValue({
      status: "ready",
      workspaceId: "00000000-0000-4000-8000-000000000001",
      path: "/repo/.git/prim/workspace-id",
      created: false,
    });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: PRIM_SKILL_REMINDER,
        reloadSkills: true,
      },
    });
    expect(result.acknowledge).toBeUndefined();
  });

  it("keeps a terminal auth notice as the only human-facing message while reloading", async () => {
    vi.mocked(isSessionEnded).mockReturnValue(true);
    vi.mocked(refreshClaudePlugins).mockResolvedValue({ installed: 1, refreshed: 1 });

    const result = await processSessionStart(ENVELOPE, "claude_code");

    expect(result.output.systemMessage).toContain("prim auth login");
    expect(result.output.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      reloadSkills: true,
    });
  });

  it("preserves Codex presence when active guidance is not recognized", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
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
    expect(hasUsableCodexGuidance).toHaveBeenCalledWith("/repo");
    expect(daemonRequest).toHaveBeenCalledWith(
      "status_snapshot",
      { callerEnv: "https://app.getprimitive.ai" },
      { timeoutMs: 250 },
    );
  });

  it("injects the Codex reminder in an active repo with usable guidance", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(hasUsableCodexGuidance).mockReturnValue(true);

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: EXPECTED_CODEX_REMINDER,
      },
    });
    expect(gitToplevel).toHaveBeenCalledWith("/repo");
    expect(isRepoActiveForCapture).toHaveBeenCalledWith("/repo");
    expect(hasUsableCodexGuidance).toHaveBeenCalledWith("/repo");
    expect(refreshClaudePlugins).not.toHaveBeenCalled();
    expect(JSON.stringify(result.output)).not.toContain("reloadSkills");
    const snapshotOrder = vi.mocked(daemonRequest).mock.invocationCallOrder[1];
    const gitOrder = vi.mocked(gitToplevel).mock.invocationCallOrder[0];
    expect(snapshotOrder).toBeLessThan(gitOrder);
  });

  it("composes the Codex reminder before fresh presence", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(hasUsableCodexGuidance).mockReturnValue(true);
    vi.mocked(daemonRequest).mockImplementation(async (method) =>
      method === "status_snapshot" ? { onlineCount: 3, presenceStale: false } : null,
    );

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: `${EXPECTED_CODEX_REMINDER}\n\n[prim] team: 3 online`,
      },
    });
  });

  it("keeps presence only when the repository is inactive", async () => {
    vi.mocked(hasUsableCodexGuidance).mockReturnValue(true);
    vi.mocked(daemonRequest).mockImplementation(async (method) =>
      method === "status_snapshot" ? { onlineCount: 3, presenceStale: false } : null,
    );

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output.hookSpecificOutput?.additionalContext).toBe("[prim] team: 3 online");
    expect(hasUsableCodexGuidance).not.toHaveBeenCalled();
  });

  it("keeps presence only outside a Git repository", async () => {
    vi.mocked(gitToplevel).mockReturnValue(null);
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(hasUsableCodexGuidance).mockReturnValue(true);
    vi.mocked(daemonRequest).mockImplementation(async (method) =>
      method === "status_snapshot" ? { onlineCount: 3, presenceStale: false } : null,
    );

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output.hookSpecificOutput?.additionalContext).toBe("[prim] team: 3 online");
    expect(isRepoActiveForCapture).not.toHaveBeenCalled();
    expect(hasUsableCodexGuidance).not.toHaveBeenCalled();
  });

  it("preserves presence when guidance detection throws", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(hasUsableCodexGuidance).mockImplementation(() => {
      throw new Error("detector failure");
    });
    vi.mocked(daemonRequest).mockImplementation(async (method) =>
      method === "status_snapshot" ? { onlineCount: 3, presenceStale: false } : null,
    );

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output.hookSpecificOutput?.additionalContext).toBe("[prim] team: 3 online");
  });

  it("emits nothing in an active repo when guidance is not recognized and presence is absent", async () => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output).toEqual({});
    expect(hasUsableCodexGuidance).toHaveBeenCalledWith("/repo");
  });

  it.each([
    ["missing", null],
    ["stale", { onlineCount: 3, presenceStale: true }],
    ["non-numeric", { onlineCount: "3", presenceStale: false }],
  ])("suppresses a %s Codex presence snapshot", async (_name, snapshot) => {
    vi.mocked(daemonRequest).mockImplementation(async (method) =>
      method === "status_snapshot" ? snapshot : null,
    );

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output).toEqual({});
    expect(refreshClaudePlugins).not.toHaveBeenCalled();
    expect(hasUsableCodexGuidance).not.toHaveBeenCalled();
  });

  it("routes Codex terminal auth ahead of presence without a reload field", async () => {
    vi.mocked(isSessionEnded).mockReturnValue(true);
    vi.mocked(daemonRequest).mockImplementation(async (method) =>
      method === "status_snapshot" ? { onlineCount: 3, presenceStale: false } : null,
    );

    const result = await processSessionStart(ENVELOPE, "codex");

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: REAUTH_NOTICE,
      },
    });
    expect(refreshClaudePlugins).not.toHaveBeenCalled();
    expect(hasUsableCodexGuidance).not.toHaveBeenCalled();
    expect(daemonRequest).toHaveBeenCalledOnce();
  });

  it("binds Hermes while keeping its SessionStart output observer-only", async () => {
    vi.mocked(isSessionEnded).mockReturnValue(true);
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
    vi.mocked(repoSyncId).mockReturnValue(undefined);
    const hermesEnvelope = JSON.stringify({
      hook_event_name: "on_session_start",
      session_id: "session-1",
      cwd: "/repo",
    });

    const result = await processSessionStart(hermesEnvelope, "hermes");

    expect(result.output).toEqual({});
    expect(bindRepository).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ quietRefresh: true }),
    );
    expect(refreshClaudePlugins).not.toHaveBeenCalled();
    expect(daemonRequest).toHaveBeenCalledWith(
      "session_start",
      { sessionId: "session-1" },
      { timeoutMs: 250 },
    );
  });

  it.each([
    ["inactive", false, null],
    ["already bound", true, "sync-existing"],
  ])("skips binding when the repository is %s", async (_name, active, binding) => {
    vi.mocked(isRepoActiveForCapture).mockReturnValue(active);
    vi.mocked(repoSyncId).mockReturnValue(binding);

    await processSessionStart(ENVELOPE, "codex");

    expect(bindRepository).not.toHaveBeenCalled();
  });

  it.each(["not json", "null", "[]", '"scalar"'])(
    "leaves invalid hook envelope %s unchanged without side effects",
    async (raw) => {
      const result = await processSessionStart(raw, "claude_code");

      expect(result.output).toEqual({});
      expect(refreshClaudePlugins).not.toHaveBeenCalled();
      expect(kickDaemonEnsure).not.toHaveBeenCalled();
      expect(daemonRequest).not.toHaveBeenCalled();
      expect(getOrCreateWorkspaceId).not.toHaveBeenCalled();
      expect(leaseDecisionFeedback).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["wrong event", { hook_event_name: "Stop", session_id: "session-1", cwd: "/repo" }],
    ["empty session id", { hook_event_name: "SessionStart", session_id: "", cwd: "/repo" }],
    ["missing session id", { hook_event_name: "SessionStart", cwd: "/repo" }],
  ])("rejects %s before any side effects", async (_name, envelope) => {
    const result = await processSessionStart(JSON.stringify(envelope), "claude_code");

    expect(result.output).toEqual({});
    expect(kickDaemonEnsure).not.toHaveBeenCalled();
    expect(daemonRequest).not.toHaveBeenCalled();
    expect(refreshClaudePlugins).not.toHaveBeenCalled();
    expect(isRepoActiveForCapture).not.toHaveBeenCalled();
    expect(getOrCreateWorkspaceId).not.toHaveBeenCalled();
    expect(leaseDecisionFeedback).not.toHaveBeenCalled();
  });
});
