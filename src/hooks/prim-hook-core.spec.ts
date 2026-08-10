import { describe, expect, it, vi } from "vitest";
import {
  canonicalRewritePairs,
  commitAttributionFromEnvironment,
  postToolInvocationId,
  shouldFlushAfter,
  toCommitMove,
  toMove,
  toRewriteMove,
  toolOutcomeFor,
} from "./prim-hook-core.js";

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
    expect(move.toolOutcome).toBe("succeeded");
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

  it("stamps an explicit V3 producer for Claude Code", () => {
    const move = toMove({ session_id: "s" }, "x");
    expect(move.producer).toBe("claude_code");
    expect(move.envelopeVersion).toBe(3);
  });

  it("stamps producer codex under --agent codex", () => {
    const move = toMove({ session_id: "s" }, "x", "codex");
    expect(move.producer).toBe("codex");
  });

  it("stamps explicit V3 Claude provenance when worktree identity is ready", () => {
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

  it("stamps canonical repository metadata when resolution succeeded", () => {
    const move = toMove({ session_id: "s", cwd: "/repo/subdir" }, "x", "claude_code", undefined, {
      repoRoot: "/repo",
      repoKey: "repo_v1_key",
      identitySource: "origin",
      repoFullName: "campus-ai/primitive",
      repoSyncId: "repoSync123",
    });
    expect(move.env).toMatchObject({
      repoRoot: "/repo",
      repoKey: "repo_v1_key",
      gitRoot: "/repo",
      repoFullName: "campus-ai/primitive",
      repoSyncId: "repoSync123",
    });
  });

  it("uses a stable PostToolUse identity when the producer supplied an invocation id", () => {
    const parsed = {
      session_id: "s",
      hook_event_name: "PostToolUse",
      tool_use_id: "tool-1",
    };
    const invocationId = postToolInvocationId(parsed, "claude_code");
    const first = toMove(parsed, "x", "claude_code", undefined, undefined, invocationId);
    const replay = toMove(parsed, "x", "claude_code", undefined, undefined, invocationId);
    expect(first.moveId).toBe(replay.moveId);
    expect(first.invocationId).toBe("tool-1");
  });

  it("makes correlated failure capture deterministic without colliding with success", () => {
    const failure = {
      session_id: "session-1",
      hook_event_name: "PostToolUseFailure",
      tool_use_id: "call-1",
    };
    const first = toMove(failure, "x", "claude_code", undefined, undefined, "call-1");
    const replay = toMove(failure, "x", "claude_code", undefined, undefined, "call-1");
    const success = toMove(
      { ...failure, hook_event_name: "PostToolUse" },
      "x",
      "claude_code",
      undefined,
      undefined,
      "call-1",
    );
    expect(first.moveId).toMatch(/^posttool:v1:/);
    expect(first.moveId).toBe(replay.moveId);
    expect(first.moveId).not.toBe(success.moveId);
  });
});

describe("postToolInvocationId", () => {
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
        { hook_event_name: "PostToolUseFailure", tool_use_id: "claude-failure" },
        "claude_code",
      ),
    ).toBe("claude-failure");
    expect(
      postToolInvocationId(
        { hook_event_name: "PreToolUse", tool_use_id: "not-post" },
        "claude_code",
      ),
    ).toBeUndefined();
  });
});

describe("toolOutcomeFor", () => {
  it("normalizes Claude success, failure, and interruption", () => {
    expect(toolOutcomeFor({ hook_event_name: "PostToolUse" }, "claude_code")).toBe("succeeded");
    expect(toolOutcomeFor({ hook_event_name: "PostToolUseFailure" }, "claude_code")).toBe("failed");
    expect(
      toolOutcomeFor({ hook_event_name: "PostToolUseFailure", is_interrupt: true }, "claude_code"),
    ).toBe("interrupted");
  });

  it("treats Codex PostToolUse as returned without inventing success", () => {
    expect(toolOutcomeFor({ hook_event_name: "PostToolUse" }, "codex")).toBe("returned");
  });

  it.each([
    ["ok", "succeeded"],
    ["success", "succeeded"],
    ["error", "failed"],
    ["timeout", "failed"],
    ["cancelled", "interrupted"],
    ["blocked", "prevented"],
    ["newer_status", "unknown"],
    [undefined, "unknown"],
  ] as const)("maps Hermes post_tool_call status %s to %s", (status, expected) => {
    expect(toolOutcomeFor({ hook_event_name: "PostToolUse", extra: { status } }, "hermes")).toBe(
      expected,
    );
  });

  it.each(["deny", "smart_deny", "timeout"])(
    "records a correlated Hermes %s approval as prevention",
    (choice) => {
      expect(
        toolOutcomeFor(
          {
            hook_event_name: "post_approval_response",
            extra: {
              choice,
              session_key: "session-1",
              tool_call_id: "call-1",
            },
          },
          "hermes",
        ),
      ).toBe("prevented");
    },
  );

  it("requires invocation correlation for Hermes approval prevention", () => {
    expect(
      toolOutcomeFor(
        { hook_event_name: "post_approval_response", extra: { choice: "deny" } },
        "hermes",
      ),
    ).toBeUndefined();
    for (const choice of ["once", "session", "always", "smart_approve"]) {
      expect(
        toolOutcomeFor(
          {
            hook_event_name: "post_approval_response",
            extra: { choice, tool_call_id: "call-1" },
          },
          "hermes",
        ),
      ).toBeUndefined();
    }
  });

  it("omits toolOutcome from unrelated moves", () => {
    expect(toMove({ session_id: "s", hook_event_name: "PreToolUse" }, "x")).not.toHaveProperty(
      "toolOutcome",
    );
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
  const workspaceId = "d84b97dc-b69f-4b59-9d0a-f6b3436239a4";
  const repoSyncId = "repoSync123";
  const commit = {
    sha: "a".repeat(40),
    parentSha: "parent0",
    branch: "main",
    files: ["src/a.ts", "src/b.ts"],
    filesComplete: true,
  };

  it("derives a deterministic v2 moveId from repository, worktree, and SHA", () => {
    const context = { repoSyncId, workspaceId };
    const first = toCommitMove(commit, "1.0.0", "/repo", context);
    const replay = toCommitMove(commit, "1.0.0", "/repo", context);
    expect(first.moveId).toMatch(/^commit:v2:[0-9a-f]{64}$/u);
    expect(replay.moveId).toBe(first.moveId);
    expect(
      toCommitMove(commit, "1.0.0", "/repo", {
        repoSyncId: "otherRepo123",
        workspaceId,
      }).moveId,
    ).not.toBe(first.moveId);
    expect(
      toCommitMove(commit, "1.0.0", "/repo", {
        repoSyncId,
        workspaceId: "00000000-0000-4000-8000-000000000001",
      }).moveId,
    ).not.toBe(first.moveId);
  });

  it("uses collision-resistant non-deterministic fallbacks without complete valid identity", () => {
    const first = toCommitMove(commit, "1.0.0", "/repo");
    const second = toCommitMove(commit, "1.0.0", "/repo");
    expect(first.moveId).toMatch(/^commit:v2:unscoped:[0-9a-f-]{36}$/u);
    expect(second.moveId).not.toBe(first.moveId);
    expect(
      toCommitMove(commit, "1.0.0", "/repo", {
        repoSyncId: "repo.with.punctuation",
        workspaceId,
      }).env,
    ).not.toHaveProperty("repoSyncId");
  });

  it("uses the git.commit eventType and an empty sessionId", () => {
    const move = toCommitMove(commit, "1.0.0", "/repo");
    expect(move.eventType).toBe("git.commit");
    expect(move.sessionId).toBe("");
  });

  it("preserves a validated synchronous hook-fire timestamp", () => {
    const capturedAt = 1_785_000_000_123;
    expect(toCommitMove(commit, "1.0.0", "/repo", { capturedAt }).capturedAt).toBe(capturedAt);
  });

  it.each([0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, Number.NaN])(
    "rejects an invalid launcher timestamp (%s)",
    (capturedAt) => {
      const now = vi.spyOn(Date, "now").mockReturnValue(1_785_000_000_456);
      try {
        expect(toCommitMove(commit, "1.0.0", "/repo", { capturedAt }).capturedAt).toBe(
          1_785_000_000_456,
        );
      } finally {
        now.mockRestore();
      }
    },
  );

  it("carries the commit facts in the payload", () => {
    const move = toCommitMove(commit, "1.0.0", "/repo");
    expect(move.payload).toMatchObject({
      kind: "git.commit",
      sha: "a".repeat(40),
      parentSha: "parent0",
      branch: "main",
      changedFiles: ["src/a.ts", "src/b.ts"],
      changedFilesComplete: true,
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
      repository: { repoRoot: "/repo", repoKey: "repo_v1_key" },
      repoFullName: "campus-ai/primitive",
      repoSyncId,
      workspaceId,
    });
    expect(move.env).toMatchObject({
      repoRoot: "/repo",
      repoKey: "repo_v1_key",
      gitRoot: "/repo",
      repoFullName: "campus-ai/primitive",
      repoSyncId,
      workspaceId,
    });
  });

  it("emits V3 only for one valid Claude/Codex session hint", () => {
    const attribution = commitAttributionFromEnvironment(
      { CLAUDE_CODE_SESSION_ID: "claude-session" },
      workspaceId,
    );
    const move = toCommitMove(commit, "1.2.3", "/repo", {
      workspaceId,
      attribution,
    });
    expect(move).toMatchObject({
      envelopeVersion: 3,
      producer: "claude_code",
      sessionId: "claude-session",
      env: { workspaceId },
    });
  });

  it.each([
    [{}, "d84b97dc-b69f-4b59-9d0a-f6b3436239a4"],
    [
      { CLAUDE_CODE_SESSION_ID: "claude", CODEX_THREAD_ID: "codex" },
      "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
    ],
    [{ CLAUDE_CODE_SESSION_ID: "claude" }, undefined],
    [{ CLAUDE_CODE_SESSION_ID: "claude" }, "not-a-workspace-id"],
    [{ HERMES_INTERACTIVE: "1" }, "d84b97dc-b69f-4b59-9d0a-f6b3436239a4"],
    [
      { HERMES_INTERACTIVE: "1", CLAUDE_CODE_SESSION_ID: "inherited-claude" },
      "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
    ],
    [
      { HERMES_INTERACTIVE: "1", CODEX_THREAD_ID: "inherited-codex" },
      "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
    ],
  ])("keeps missing, conflicting, unbound, and Hermes commits sessionless", (env, workspaceId) => {
    const attribution = commitAttributionFromEnvironment(env, workspaceId);
    const move = toCommitMove(commit, "1.2.3", "/repo", { workspaceId, attribution });
    expect(move.envelopeVersion).toBe(1);
    expect(move.sessionId).toBe("");
    expect("producer" in move).toBe(false);
  });
});

describe("toRewriteMove", () => {
  const workspaceId = "d84b97dc-b69f-4b59-9d0a-f6b3436239a4";
  const repoSyncId = "repoSync123";
  const oldA = "a".repeat(40);
  const oldB = "b".repeat(40);
  const landed = "c".repeat(40);
  const context = {
    repository: { repoRoot: "/repo", repoKey: "repo_v1_key" },
    repoFullName: "campus-ai/primitive",
    repoSyncId,
    workspaceId,
    capturedAt: 1_785_000_000_123,
  };

  it("canonicalizes case/order, drops self-pairs, and preserves many-to-one rewrites", () => {
    expect(
      canonicalRewritePairs([
        { oldSha: oldB.toUpperCase(), newSha: landed.toUpperCase() },
        { oldSha: landed, newSha: landed },
        { oldSha: oldA, newSha: landed },
        { oldSha: oldB, newSha: landed },
      ]),
    ).toEqual([
      { oldSha: oldA, newSha: landed },
      { oldSha: oldB, newSha: landed },
    ]);
  });

  it("pins the V1 envelope and deterministic move identity contract", () => {
    const [move] = toRewriteMove(
      { source: "rebase", pairs: [{ oldSha: oldA, newSha: landed }], branch: "feature" },
      "1.2.3",
      "/repo",
      context,
    );
    expect(move).toEqual({
      moveId: "rewrite:v1:7ee2319a14e49373591561f4ced6145141ccaa919571774d6de76a9627cba8c5",
      capturedAt: 1_785_000_000_123,
      sessionId: "",
      eventType: "git.rewrite",
      payload: {
        kind: "git.rewrite",
        source: "rebase",
        pairs: [{ oldSha: oldA, newSha: landed }],
        branch: "feature",
      },
      env: {
        cwd: "/repo",
        cliVersion: "1.2.3",
        osPlatform: process.platform,
        repoRoot: "/repo",
        repoKey: "repo_v1_key",
        gitRoot: "/repo",
        repoFullName: "campus-ai/primitive",
        repoSyncId,
        workspaceId,
      },
      envelopeVersion: 1,
    });
    expect(move).not.toHaveProperty("producer");
  });

  it("excludes branch and capture time while including source and pair identity", () => {
    const rewrite = { source: "amend" as const, pairs: [{ oldSha: oldA, newSha: landed }] };
    const [first] = toRewriteMove(rewrite, "1.2.3", "/repo", context);
    const [replay] = toRewriteMove({ ...rewrite, branch: "renamed" }, "9.9.9", "/different-cwd", {
      ...context,
      capturedAt: 1_785_000_999_999,
    });
    const [differentSource] = toRewriteMove(
      { ...rewrite, source: "rebase" },
      "1.2.3",
      "/repo",
      context,
    );
    expect(replay.moveId).toBe(first.moveId);
    expect(differentSource.moveId).not.toBe(first.moveId);
  });

  it("chunks 40 pairs per move after deterministic sorting", () => {
    const pairs = Array.from({ length: 81 }, (_, index) => ({
      oldSha: index.toString(16).padStart(40, "0"),
      newSha: (index + 1_000).toString(16).padStart(40, "0"),
    })).reverse();
    const moves = toRewriteMove({ source: "rebase", pairs }, "1.2.3", "/repo", context);
    expect(moves).toHaveLength(3);
    expect((moves[0].payload as { pairs: unknown[] }).pairs).toHaveLength(40);
    expect((moves[1].payload as { pairs: unknown[] }).pairs).toHaveLength(40);
    expect((moves[2].payload as { pairs: unknown[] }).pairs).toHaveLength(1);
    expect(moves.map((move) => move.moveId)).toEqual([
      ...new Set(moves.map((move) => move.moveId)),
    ]);
  });

  it("truncates canonically to 2,000 pairs independent of input order", () => {
    const pairs = Array.from({ length: 2_005 }, (_, index) => ({
      oldSha: index.toString(16).padStart(40, "0"),
      newSha: (index + 10_000).toString(16).padStart(40, "0"),
    }));
    const forward = toRewriteMove({ source: "rebase", pairs }, "x", "/repo", context);
    const reverse = toRewriteMove(
      { source: "rebase", pairs: [...pairs].reverse() },
      "x",
      "/repo",
      context,
    );
    expect(forward).toHaveLength(50);
    expect(reverse.map((move) => move.moveId)).toEqual(forward.map((move) => move.moveId));
  });

  it("fails closed without both repository and worktree identities", () => {
    const rewrite = { source: "amend" as const, pairs: [{ oldSha: oldA, newSha: landed }] };
    expect(toRewriteMove(rewrite, "x", "/repo", { ...context, repoSyncId: undefined })).toEqual([]);
    expect(toRewriteMove(rewrite, "x", "/repo", { ...context, workspaceId: undefined })).toEqual(
      [],
    );
  });
});
