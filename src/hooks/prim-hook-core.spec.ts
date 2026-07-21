import { describe, expect, it } from "vitest";
import { shouldFlushAfter, toCommitMove, toMove } from "./prim-hook-core.js";

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
    expect(move.envelopeVersion).toBe(1);
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

  it("omits producer for Claude Code (byte-identical wire)", () => {
    const move = toMove({ session_id: "s" }, "x");
    expect(move.producer).toBeUndefined();
    expect("producer" in move).toBe(false);
  });

  it("stamps producer codex under --agent codex", () => {
    const move = toMove({ session_id: "s" }, "x", "codex");
    expect(move.producer).toBe("codex");
  });

  it("stamps explicit V2 Claude provenance only when worktree identity is ready", () => {
    const workspaceId = "d84b97dc-b69f-4b59-9d0a-f6b3436239a4";
    const move = toMove({ session_id: "s", cwd: "/repo" }, "x", "claude_code", workspaceId);
    expect(move).toMatchObject({
      envelopeVersion: 2,
      producer: "claude_code",
      env: { cwd: "/repo", workspaceId },
    });
  });

  it("uses the same V2 provenance shape for other agents", () => {
    const workspaceId = "d84b97dc-b69f-4b59-9d0a-f6b3436239a4";
    const move = toMove({ session_id: "s" }, "x", "codex", workspaceId);
    expect(move.envelopeVersion).toBe(2);
    expect(move.producer).toBe("codex");
    expect(move.env).toMatchObject({ workspaceId });
  });

  it("stamps canonical repository metadata when resolution succeeded", () => {
    const move = toMove({ session_id: "s", cwd: "/repo/subdir" }, "x", "claude_code", undefined, {
      repoRoot: "/repo",
      repoKey: "repo_v1_key",
      identitySource: "origin",
    });
    expect(move.env).toMatchObject({ repoRoot: "/repo", repoKey: "repo_v1_key" });
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

  it("stamps repository metadata on commit boundaries", () => {
    const move = toCommitMove(commit, "1.2.3", "/repo", {
      repoRoot: "/repo",
      repoKey: "repo_v1_key",
    });
    expect(move.env).toMatchObject({ repoRoot: "/repo", repoKey: "repo_v1_key" });
  });
});
