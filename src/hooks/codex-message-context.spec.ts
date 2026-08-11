import { describe, expect, it, vi } from "vitest";
import { processCodexMessageContext } from "./codex-message-context.js";

function prepared(overrides: Record<string, unknown> = {}) {
  return {
    context: undefined,
    decisionDigest: undefined,
    feedAvailable: true,
    acknowledge: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

describe("processCodexMessageContext", () => {
  it("delivers cached context through UserPromptSubmit and acknowledges after handoff", async () => {
    const context = prepared({
      context: "[prim] Decisions captured since last message: Taylor — “Use the daemon cache”",
      decisionDigest:
        "[prim] Decisions captured since last message: Taylor — “Use the daemon cache”",
    });
    const prepare = vi.fn().mockResolvedValue(context);

    const result = await processCodexMessageContext(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: "/repo",
      },
      { prepare },
    );

    expect(prepare).toHaveBeenCalledWith({ cwd: "/repo", sessionId: "session-1" });
    expect(result.output).toEqual({
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: context.context,
      },
    });
    expect(context.acknowledge).not.toHaveBeenCalled();
    await result.acknowledge?.();
    expect(context.acknowledge).toHaveBeenCalledWith(true);
  });

  it("acknowledges a verified quiet prompt after its empty response is handed off", async () => {
    const context = prepared();
    const result = await processCodexMessageContext(
      { hook_event_name: "UserPromptSubmit", session_id: "session-quiet" },
      { prepare: vi.fn().mockResolvedValue(context) },
    );

    expect(result.output).toEqual({});
    await result.acknowledge?.();
    expect(context.acknowledge).toHaveBeenCalledWith(true);
  });

  it("blocks Stop once when a Decision appeared after the prompt", async () => {
    const context = prepared({
      context:
        "primitive 1.2.3 (daemon: live)\n\n[prim] Decisions captured since last message: Taylor — “Use Stop as a backstop”",
      decisionDigest:
        "[prim] Decisions captured since last message: Taylor — “Use Stop as a backstop”",
    });
    const result = await processCodexMessageContext(
      { hook_event_name: "Stop", session_id: "session-2", stop_hook_active: false },
      { prepare: vi.fn().mockResolvedValue(context) },
    );

    expect(result.output).toMatchObject({ decision: "block" });
    expect((result.output as { reason: string }).reason).toContain("Use Stop as a backstop");
    expect((result.output as { reason: string }).reason).toContain("proactively tell the user");
    await result.acknowledge?.();
    expect(context.acknowledge).toHaveBeenCalledWith(true);
  });

  it("does not recurse when Codex marks the Stop hook active", async () => {
    const prepare = vi.fn();
    const result = await processCodexMessageContext(
      { hook_event_name: "Stop", session_id: "session-3", stop_hook_active: true },
      { prepare },
    );
    expect(result).toEqual({ output: {} });
    expect(prepare).not.toHaveBeenCalled();
  });

  it("leaves a status-only Stop unacknowledged for the next prompt", async () => {
    const context = prepared({ context: "primitive 1.2.3 (daemon: down)" });
    const result = await processCodexMessageContext(
      { hook_event_name: "Stop", session_id: "session-4" },
      { prepare: vi.fn().mockResolvedValue(context) },
    );
    expect(result).toEqual({ output: {} });
    expect(context.acknowledge).not.toHaveBeenCalled();
  });

  it("fails open on malformed input and context errors", async () => {
    const prepare = vi.fn().mockRejectedValue(new Error("daemon failure"));
    await expect(
      processCodexMessageContext(
        { hook_event_name: "UserPromptSubmit", session_id: "session-5" },
        { prepare },
      ),
    ).resolves.toEqual({ output: {} });
    await expect(
      processCodexMessageContext(
        { hook_event_name: "UserPromptSubmit", session_id: "" },
        { prepare },
      ),
    ).resolves.toEqual({ output: {} });
  });
});
