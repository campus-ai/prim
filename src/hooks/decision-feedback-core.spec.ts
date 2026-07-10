import { describe, expect, it, vi } from "vitest";
import {
  type DecisionFeedbackHookDeps,
  decisionFeedbackSystemMessage,
} from "./decision-feedback-core.js";

const EVENT = {
  decisionId: "jx7fpmycwabtzke040y7vecnnh8870pg",
  shortId: "abc12345",
  intent: "Adopt Redis for cache invalidation",
};

function deps(overrides: Partial<DecisionFeedbackHookDeps> = {}) {
  return {
    isRepoActiveForCapture: vi.fn(() => true),
    gitToplevel: vi.fn(() => "/repo"),
    drainDecisionFeedback: vi.fn().mockResolvedValue([EVENT]),
    ...overrides,
  };
}

describe("decisionFeedbackSystemMessage", () => {
  it("drains Stop feedback for the current session", async () => {
    const d = deps();
    const message = await decisionFeedbackSystemMessage(
      { hook_event_name: "Stop", session_id: "sess-123", cwd: "/repo/pkg" },
      d,
    );
    expect(message).toContain("dec_abc12345");
    expect(d.drainDecisionFeedback).toHaveBeenCalledWith({
      repoCwd: "/repo",
      scope: "session",
      sessionId: "sess-123",
    });
  });

  it("drains SessionStart feedback for the current session", async () => {
    const d = deps();
    await decisionFeedbackSystemMessage(
      { hook_event_name: "SessionStart", session_id: "sess-123", cwd: "/repo" },
      d,
    );
    expect(d.drainDecisionFeedback).toHaveBeenCalledWith({
      repoCwd: "/repo",
      scope: "session",
      sessionId: "sess-123",
    });
  });

  it("does not drain without a Claude session id", async () => {
    const d = deps();
    await expect(
      decisionFeedbackSystemMessage({ hook_event_name: "SessionStart", cwd: "/repo" }, d),
    ).resolves.toBeUndefined();
    expect(d.drainDecisionFeedback).not.toHaveBeenCalled();
  });

  it("short-circuits outside active repos", async () => {
    const d = deps({ isRepoActiveForCapture: vi.fn(() => false) });
    await expect(
      decisionFeedbackSystemMessage({ hook_event_name: "Stop", cwd: "/repo" }, d),
    ).resolves.toBeUndefined();
    expect(d.drainDecisionFeedback).not.toHaveBeenCalled();
  });

  it("fails soft when the drain throws", async () => {
    const d = deps({ drainDecisionFeedback: vi.fn().mockRejectedValue(new Error("nope")) });
    await expect(
      decisionFeedbackSystemMessage({ hook_event_name: "Stop", cwd: "/repo" }, d),
    ).resolves.toBeUndefined();
  });
});
