import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("normalizes Cursor identity, event, cwd, output, and sensitive fields", () => {
    const root = mkdtempSync(join(tmpdir(), "prim-cursor-normalize-"));
    execFileSync("git", ["init", "-q", root]);
    const output = normalizeEnvelope(
      {
        hook_event_name: "postToolUse",
        conversation_id: "conversation-1",
        generation_id: "generation-1",
        tool_name: "Write",
        tool_use_id: "tool-1",
        tool_input: { file_path: join(root, "src/app.ts") },
        tool_output: '{"ok":true}',
        workspace_roots: [root],
        user_email: "private@example.com",
        transcript_path: "/private/transcript.json",
        thoughts: "not for capture",
      },
      "cursor",
    );
    expect(output).toMatchObject({
      hook_event_name: "PostToolUse",
      session_id: "conversation-1",
      turn_id: "generation-1",
      tool_use_id: "tool-1",
      cwd: realpathSync.native(root),
      tool_response: { ok: true },
    });
    expect(output).not.toHaveProperty("conversation_id");
    expect(output).not.toHaveProperty("generation_id");
    expect(output).not.toHaveProperty("tool_output");
    expect(output).not.toHaveProperty("user_email");
    expect(output).not.toHaveProperty("transcript_path");
    expect(output).not.toHaveProperty("thoughts");
  });

  it("derives one protocol-safe Cursor invocation id from an unsafe native id", () => {
    const root = mkdtempSync(join(tmpdir(), "prim-cursor-tool-id-"));
    execFileSync("git", ["init", "-q", root]);
    const base = {
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      tool_name: "Write",
      tool_use_id: "call-1\nfc_2",
      tool_input: { file_path: join(root, "src/app.ts") },
      workspace_roots: [root],
    };
    const pre = normalizeEnvelope({ ...base, hook_event_name: "preToolUse" }, "cursor");
    const post = normalizeEnvelope({ ...base, hook_event_name: "postToolUse" }, "cursor");

    expect(pre.tool_use_id).toMatch(/^cursor:tool:v1:[0-9a-f]{64}$/u);
    expect(post.tool_use_id).toBe(pre.tool_use_id);
  });

  it("rejects missing, conflicting, and cross-repository Cursor identity", () => {
    const first = mkdtempSync(join(tmpdir(), "prim-cursor-first-"));
    const second = mkdtempSync(join(tmpdir(), "prim-cursor-second-"));
    execFileSync("git", ["init", "-q", first]);
    execFileSync("git", ["init", "-q", second]);
    const base = {
      hook_event_name: "preToolUse",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      tool_name: "Write",
      tool_use_id: "tool-1",
      tool_input: { file_path: join(first, "a.ts") },
      workspace_roots: [first],
    };
    expect(() => normalizeEnvelope({ ...base, tool_use_id: undefined }, "cursor")).toThrow(
      /tool_use_id/u,
    );
    expect(() => normalizeEnvelope({ ...base, session_id: "different" }, "cursor")).toThrow(
      /conflicts/u,
    );
    expect(() =>
      normalizeEnvelope({ ...base, workspace_roots: [first, second] }, "cursor"),
    ).toThrow(/multiple repositories/u);
    expect(() =>
      normalizeEnvelope({ ...base, workspace_roots: ["relative/repository"] }, "cursor"),
    ).toThrow(/must be absolute/u);
  });

  it("uses the unique repository when multiple workspace folders share it", () => {
    const root = mkdtempSync(join(tmpdir(), "prim-cursor-multi-root-"));
    execFileSync("git", ["init", "-q", root]);
    mkdirSync(join(root, "packages", "a"), { recursive: true });
    mkdirSync(join(root, "packages", "b"), { recursive: true });

    const output = normalizeEnvelope(
      {
        hook_event_name: "sessionStart",
        conversation_id: "conversation-1",
        generation_id: "generation-1",
        workspace_roots: [join(root, "packages", "a"), join(root, "packages", "b")],
      },
      "cursor",
    );

    expect(output.cwd).toBe(realpathSync.native(root));
  });
});
