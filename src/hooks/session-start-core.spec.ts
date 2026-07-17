import { describe, expect, it, vi } from "vitest";
import { handoffHookOutput } from "./decision-feedback-core.js";
import {
  PRIM_SKILL_REMINDER,
  type SessionStartDependencies,
  processSessionStart,
} from "./session-start-core.js";

const ENVELOPE = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "session-1",
  cwd: "/repo",
});

class FakeOutput {
  chunks: string[] = [];
  callback: ((error?: Error | null) => void) | undefined;
  errorListener: ((error: Error) => void) | undefined;

  once(_event: "error", listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  off(_event: "error", listener: (error: Error) => void): void {
    if (this.errorListener === listener) this.errorListener = undefined;
  }

  write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    this.callback = callback;
    return true;
  }
}

function dependencyFixture(
  overrides: Partial<SessionStartDependencies> = {},
): Partial<SessionStartDependencies> {
  return {
    daemonRequest: vi.fn(async () => null) as unknown as SessionStartDependencies["daemonRequest"],
    getOrCreateWorkspaceId: vi.fn(() => ({ status: "not_git" })),
    getSiteUrl: vi.fn(() => "https://app.getprimitive.ai"),
    isRepoActiveForCapture: vi.fn(() => false),
    isSessionEnded: vi.fn(() => false),
    kickDaemonEnsure: vi.fn(),
    leaseDecisionFeedback: vi.fn(async () => undefined),
    refreshClaudePlugins: vi.fn(() => ({ installed: 0, refreshed: 0 })),
    ...overrides,
  } as Partial<SessionStartDependencies>;
}

describe("processSessionStart", () => {
  it("injects the proactive reminder in an active repo with a recognized skill", async () => {
    const result = await processSessionStart(
      ENVELOPE,
      "claude_code",
      dependencyFixture({
        isRepoActiveForCapture: vi.fn(() => true),
        refreshClaudePlugins: vi.fn(() => ({ installed: 1, refreshed: 0 })),
      }),
    );

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: PRIM_SKILL_REMINDER,
      },
    });
  });

  it("requests a same-session skill reload after refresh, even in an inactive repo", async () => {
    const result = await processSessionStart(
      ENVELOPE,
      "claude_code",
      dependencyFixture({
        isRepoActiveForCapture: vi.fn(() => false),
        refreshClaudePlugins: vi.fn(() => ({ installed: 1, refreshed: 1 })),
      }),
    );

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        reloadSkills: true,
      },
    });
  });

  it("emits neither reminder nor reload when no recognized skill is installed", async () => {
    const result = await processSessionStart(
      ENVELOPE,
      "claude_code",
      dependencyFixture({
        isRepoActiveForCapture: vi.fn(() => true),
        refreshClaudePlugins: vi.fn(() => ({ installed: 0, refreshed: 0 })),
      }),
    );

    expect(result.output).toEqual({});
  });

  it("coexists with feedback and acknowledges only after the combined output is handed off", async () => {
    const acknowledge = vi.fn(async () => true);
    const result = await processSessionStart(
      ENVELOPE,
      "claude_code",
      dependencyFixture({
        acknowledgeDecisionFeedback: acknowledge,
        getOrCreateWorkspaceId: vi.fn(() => ({
          status: "ready",
          workspaceId: "00000000-0000-4000-8000-000000000001",
          path: "/repo/.git/prim/workspace-id",
          created: false,
        })),
        isRepoActiveForCapture: vi.fn(() => true),
        leaseDecisionFeedback: vi.fn(async () => ({ events: [], hasMore: false })),
        refreshClaudePlugins: vi.fn(() => ({ installed: 1, refreshed: 1 })),
        renderFeedback: vi.fn(() => ({
          systemMessage: "feedback",
          deliveries: [{ eventId: "event-1", leaseVersion: 1 }],
        })),
      }),
    );

    expect(result.output).toEqual({
      systemMessage: "feedback",
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: PRIM_SKILL_REMINDER,
        reloadSkills: true,
      },
    });

    const stream = new FakeOutput();
    const pending = handoffHookOutput(result.output, result.acknowledge, stream);
    await Promise.resolve();
    expect(acknowledge).not.toHaveBeenCalled();
    stream.callback?.();
    await expect(pending).resolves.toBe(true);
    expect(acknowledge).toHaveBeenCalledOnce();
  });

  it("keeps a terminal auth notice as the only human-facing message while reloading", async () => {
    const result = await processSessionStart(
      ENVELOPE,
      "claude_code",
      dependencyFixture({
        isRepoActiveForCapture: vi.fn(() => true),
        isSessionEnded: vi.fn(() => true),
        refreshClaudePlugins: vi.fn(() => ({ installed: 1, refreshed: 1 })),
      }),
    );

    expect(result.output.systemMessage).toContain("prim auth login");
    expect(result.output.hookSpecificOutput).toEqual({
      hookEventName: "SessionStart",
      reloadSkills: true,
    });
  });

  it("leaves Codex presence behavior unchanged and never refreshes Claude skills", async () => {
    const refresh = vi.fn(() => ({ installed: 1, refreshed: 1 }));
    const daemon = vi.fn(async (method: string) =>
      method === "status_snapshot" ? { onlineCount: 3, presenceStale: false } : null,
    );
    const result = await processSessionStart(
      ENVELOPE,
      "codex",
      dependencyFixture({
        daemonRequest: daemon as unknown as SessionStartDependencies["daemonRequest"],
        refreshClaudePlugins: refresh,
      }),
    );

    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "[prim] team: 3 online",
      },
    });
    expect(refresh).not.toHaveBeenCalled();
  });

  it("leaves invalid hook envelopes unchanged without attempting refresh", async () => {
    const refresh = vi.fn(() => ({ installed: 1, refreshed: 1 }));
    const result = await processSessionStart(
      "not json",
      "claude_code",
      dependencyFixture({ refreshClaudePlugins: refresh }),
    );

    expect(result.output).toEqual({});
    expect(refresh).not.toHaveBeenCalled();
  });
});
