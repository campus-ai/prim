import { describe, expect, it } from "vitest";
import { postToolInvocationId, shouldFlushAfter, toCommitMove, toMove } from "./prim-hook-core.js";

describe("toMove", () => {
  it("maps the Claude Code hook field names onto the envelope", () => {
    const move = toMove(
      { session_id: "sess-123", hook_event_name: "PostToolUse", cwd: "/repo" },
      "1.2.3",
    );
    expect(move.sessionId).toBe("sess-123");
    expect(move.eventType).toBe("PostToolUse");
    expect(move.env.cwd).toBe("/repo");
    expect(move.env.cliVersion).toBe("1.2.3");
    expect(typeof move.moveId).toBe("string");
    expect(typeof move.capturedAt).toBe("number");
    expect(move.envelopeVersion).toBe(3);
    expect(move.producer).toBe("claude_code");
  });

  it("stores the raw hook event verbatim as payload", () => {
    const parsed = {
      session_id: "s",
      hook_event_name: "PreToolUse",
      tool_input: { file_path: "/a.ts" },
    };
    const move = toMove(parsed, "x");
    expect(move.payload).toBe(parsed);
  });

  it("falls back without throwing when fields are absent", () => {
    const move = toMove({}, "x");
    expect(move.sessionId).toBe("");
    expect(move.eventType).toBe("unknown");
    expect(move.env.cwd).toBe(process.cwd());
  });

  it("always stamps an explicit Claude producer for classifier sequencing", () => {
    const move = toMove({ session_id: "s" }, "x");
    expect(move.producer).toBe("claude_code");
    expect(move.envelopeVersion).toBe(3);
  });

  it("stamps producer codex under --agent codex", () => {
    const move = toMove({ session_id: "s" }, "x", "codex");
    expect(move.producer).toBe("codex");
  });

  it("stamps optional worktree provenance on the V3 Claude envelope", () => {
    const workspaceId = "d84b97dc-b69f-4b59-9d0a-f6b3436239a4";
    const move = toMove({ session_id: "s", cwd: "/repo" }, "x", "claude_code", workspaceId);
    expect(move).toMatchObject({
      envelopeVersion: 3,
      producer: "claude_code",
      env: { cwd: "/repo", workspaceId },
    });
  });

  it("uses the same V3 provenance shape for other agents", () => {
    const workspaceId = "d84b97dc-b69f-4b59-9d0a-f6b3436239a4";
    const move = toMove({ session_id: "s" }, "x", "codex", workspaceId);
    expect(move.envelopeVersion).toBe(3);
    expect(move.producer).toBe("codex");
    expect(move.env).toMatchObject({ workspaceId });
  });

  it("carries the preflight invocation id only when supplied by successful post capture", () => {
    expect(
      toMove(
        { session_id: "s", hook_event_name: "PostToolUse" },
        "x",
        "claude_code",
        undefined,
        "tool-1",
      ),
    ).toMatchObject({ invocationId: "tool-1" });
    expect(toMove({ session_id: "s" }, "x")).not.toHaveProperty("invocationId");
  });

  it("derives the specified deterministic PostToolUse id", () => {
    const move = toMove(
      { session_id: "sess-123", hook_event_name: "PostToolUse" },
      "x",
      "claude_code",
      undefined,
      "tool-1",
    );
    expect(move.moveId).toBe(
      "posttool:v1:ab909ec351eae8ff307805fe71ab9f665b475ece7df8f814b86d838fd1b2e5b3",
    );
  });

  it("gives passive and dedicated capture the same PostToolUse id", () => {
    const args = { session_id: "session-1", hook_event_name: "PostToolUse" };
    const passive = toMove(args, "x", "hermes", "workspace-1", "call-1");
    const dedicated = toMove(args, "x", "hermes", "workspace-1", "call-1");
    expect(passive.moveId).toBe(dedicated.moveId);
  });

  it("separates PostToolUse ids by producer, session, invocation, and event type", () => {
    const post = { session_id: "session-1", hook_event_name: "PostToolUse" };
    const base = toMove(post, "x", "claude_code", undefined, "call-1").moveId;
    const ids = [
      toMove(post, "x", "codex", undefined, "call-1").moveId,
      toMove({ ...post, session_id: "session-2" }, "x", "claude_code", undefined, "call-1").moveId,
      toMove(post, "x", "claude_code", undefined, "call-2").moveId,
      toMove({ ...post, hook_event_name: "PreToolUse" }, "x", "claude_code", undefined, "call-1")
        .moveId,
    ];
    expect(ids).not.toContain(base);
    expect(new Set([base, ...ids]).size).toBe(5);
  });

  it("retains random ids without complete PostToolUse identity", () => {
    const missingInvocation = toMove(
      { session_id: "session-1", hook_event_name: "PostToolUse" },
      "x",
    );
    const missingSession = toMove(
      { hook_event_name: "PostToolUse" },
      "x",
      "claude_code",
      undefined,
      "call-1",
    );
    expect(missingInvocation.moveId).not.toMatch(/^posttool:v1:/);
    expect(missingSession.moveId).not.toMatch(/^posttool:v1:/);
  });

  it("extracts the same invocation identity used by each host capture path", () => {
    expect(
      postToolInvocationId(
        { hook_event_name: "PostToolUse", tool_use_id: "claude-call" },
        "claude_code",
      ),
    ).toBe("claude-call");
    expect(
      postToolInvocationId({ hook_event_name: "PostToolUse", tool_use_id: "codex-call" }, "codex"),
    ).toBe("codex-call");
    expect(
      postToolInvocationId(
        { hook_event_name: "PostToolUse", extra: { tool_call_id: "hermes-call" } },
        "hermes",
      ),
    ).toBe("hermes-call");
    expect(
      postToolInvocationId(
        { hook_event_name: "PreToolUse", tool_use_id: "not-post" },
        "claude_code",
      ),
    ).toBeUndefined();
  });
});

describe("shouldFlushAfter", () => {
  it("kicks a background drain on session end", () => {
    expect(shouldFlushAfter("SessionEnd")).toBe(true);
  });

  it("does not drain on routine per-tool or session events", () => {
    for (const event of [
      "PreToolUse",
      "PostToolUse",
      "Stop",
      "SubagentStop",
      "SessionStart",
      "unknown",
    ]) {
      expect(shouldFlushAfter(event)).toBe(false);
    }
  });
});

describe("toCommitMove", () => {
  const commit = {
    sha: "abc123",
    parentSha: "parent0",
    branch: "main",
    files: ["src/a.ts", "src/b.ts"],
  };

  it("derives a deterministic moveId from the sha", () => {
    expect(toCommitMove(commit, "1.0.0", "/repo").moveId).toBe("commit:abc123");
  });

  it("uses the git.commit eventType and an empty sessionId", () => {
    const move = toCommitMove(commit, "1.0.0", "/repo");
    expect(move.eventType).toBe("git.commit");
    expect(move.sessionId).toBe("");
  });

  it("carries the commit facts in the payload", () => {
    const move = toCommitMove(commit, "1.0.0", "/repo");
    expect(move.payload).toMatchObject({
      kind: "git.commit",
      sha: "abc123",
      parentSha: "parent0",
      branch: "main",
      files: ["src/a.ts", "src/b.ts"],
    });
  });

  it("stamps env + envelopeVersion and never a producer", () => {
    const move = toCommitMove(commit, "1.2.3", "/repo");
    expect(move.env.cwd).toBe("/repo");
    expect(move.env.cliVersion).toBe("1.2.3");
    expect(move.envelopeVersion).toBe(1);
    expect("producer" in move).toBe(false);
  });
});
