import { describe, expect, it } from "vitest";
import { normalizeEnvelope } from "./normalize.js";

describe("normalizeEnvelope", () => {
  it("maps every Hermes shell-hook event to prim's internal name", () => {
    const cases: Array<[string, string]> = [
      ["on_session_start", "SessionStart"],
      ["on_session_end", "SessionEnd"],
      ["pre_llm_call", "UserPromptSubmit"],
      ["post_llm_call", "Stop"],
      ["pre_tool_call", "PreToolUse"],
      ["post_tool_call", "PostToolUse"],
      ["subagent_stop", "SubagentStop"],
    ];
    for (const [hermes, internal] of cases) {
      const out = normalizeEnvelope({ hook_event_name: hermes, session_id: "s" }, "hermes");
      expect(out.hook_event_name).toBe(internal);
      // Identity fields ride through untouched — only the event name is remapped.
      expect(out.session_id).toBe("s");
    }
  });

  it("leaves a Hermes event with no internal analog untouched", () => {
    const out = normalizeEnvelope({ hook_event_name: "on_session_reset" }, "hermes");
    expect(out.hook_event_name).toBe("on_session_reset");
  });

  it("does not mutate the caller's object when it remaps", () => {
    const input = { hook_event_name: "pre_tool_call" };
    const out = normalizeEnvelope(input, "hermes");
    expect(input.hook_event_name).toBe("pre_tool_call");
    expect(out.hook_event_name).toBe("PreToolUse");
    expect(out).not.toBe(input);
  });

  it("is a no-op for Claude Code and complete Codex envelopes", () => {
    const claude = { hook_event_name: "PreToolUse" };
    expect(normalizeEnvelope(claude, "claude_code")).toBe(claude);
    const codex = { hook_event_name: "PreToolUse", tool_use_id: "call-1" };
    expect(normalizeEnvelope(codex, "codex")).toBe(codex);
    // It never remaps a Hermes-shaped name for a non-Hermes agent.
    const odd = { hook_event_name: "pre_tool_call" };
    expect(normalizeEnvelope(odd, "claude_code").hook_event_name).toBe("pre_tool_call");
  });

  it("derives one stable Codex invocation id across missing-id pre/post envelopes", () => {
    const base = {
      session_id: "session-1",
      turn_id: "turn-1",
      tool_name: "apply_patch",
      tool_input: { patch: "*** Begin Patch" },
    };
    const pre = normalizeEnvelope({ ...base, hook_event_name: "PreToolUse" }, "codex");
    const post = normalizeEnvelope(
      { ...base, hook_event_name: "PostToolUse", tool_response: "Done" },
      "codex",
    );

    expect(pre.tool_use_id).toMatch(/^codex:fallback:v1:[0-9a-f]{64}$/u);
    expect(post.tool_use_id).toBe(pre.tool_use_id);
  });

  it("preserves a host-provided Codex invocation id", () => {
    const input = {
      hook_event_name: "PostToolUse",
      tool_use_id: "call-1",
      session_id: "session-1",
    };
    expect(normalizeEnvelope(input, "codex")).toBe(input);
  });

  it("tolerates a missing or non-string event name", () => {
    expect(normalizeEnvelope({}, "hermes")).toEqual({});
    expect(normalizeEnvelope({ hook_event_name: 42 }, "hermes").hook_event_name).toBe(42);
  });
});
