/**
 * Decision Event Pipeline — pure capture core.
 *
 * The mapping from a raw Claude Code hook event onto a Move envelope, and
 * the policy for when a capture should trigger a background drain. Kept
 * free of I/O so the wire mapping can be unit-pinned: a silent rename of a
 * Claude Code field (e.g. hook_event_name) would otherwise zero the
 * pipeline invisibly.
 */
import { createHash, randomUUID } from "node:crypto";
import { platform } from "node:os";
import { AGENT_ENVELOPE_VERSION, ENVELOPE_VERSION, type Move } from "../protocol/move.js";
import type { Agent } from "./agent.js";

export function postToolInvocationId(
  parsed: Record<string, unknown>,
  agent: Agent,
): string | undefined {
  if (parsed.hook_event_name !== "PostToolUse") return undefined;
  const raw =
    agent === "hermes"
      ? (parsed.extra as { tool_call_id?: unknown } | undefined)?.tool_call_id
      : parsed.tool_use_id;
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}

export function toMove(
  parsed: Record<string, unknown>,
  cliVersion: string,
  agent: Agent = "claude_code",
  workspaceId?: string,
  invocationId?: string,
): Move {
  const sessionId = (parsed.session_id as string | undefined) ?? "";
  const eventType = (parsed.hook_event_name as string | undefined) ?? "unknown";
  const moveId =
    eventType === "PostToolUse" && sessionId && invocationId
      ? `posttool:v1:${createHash("sha256")
          .update(JSON.stringify([agent, sessionId, eventType, invocationId]))
          .digest("hex")}`
      : randomUUID();
  return {
    moveId,
    capturedAt: Date.now(),
    sessionId,
    eventType,
    payload: parsed,
    env: {
      cwd: (parsed.cwd as string | undefined) ?? process.cwd(),
      cliVersion,
      osPlatform: platform(),
      ...(workspaceId ? { workspaceId } : {}),
    },
    envelopeVersion: AGENT_ENVELOPE_VERSION,
    producer: agent,
    ...(invocationId ? { invocationId } : {}),
  };
}

export type CommitInfo = {
  sha: string;
  parentSha?: string;
  branch?: string;
  files: string[];
};

/**
 * Build the Move a git post-commit hook emits. The commit bounds a
 * classification window server-side; its deterministic moveId
 * (`commit:<sha>`) makes a double-fired or replayed hook idempotent at the
 * by_move_id lookup. eventType "git.commit" matches the server's
 * GIT_COMMIT_EVENT — a cross-repo wire contract. No producer is stamped: a
 * git hook fires for every commit regardless of which agent (if any) was
 * running, and the decision's agent attribution comes from the session's
 * own moves, not the commit envelope.
 */
export function toCommitMove(commit: CommitInfo, cliVersion: string, cwd: string): Move {
  return {
    moveId: `commit:${commit.sha}`,
    capturedAt: Date.now(),
    sessionId: "",
    eventType: "git.commit",
    payload: {
      kind: "git.commit",
      sha: commit.sha,
      parentSha: commit.parentSha,
      branch: commit.branch,
      files: commit.files,
    },
    env: {
      cwd,
      cliVersion,
      osPlatform: platform(),
    },
    envelopeVersion: ENVELOPE_VERSION,
  };
}

/**
 * Session-terminal events at which the hook kicks a best-effort background
 * drain, so a session's moves reach the server promptly instead of waiting
 * for the next interactive `prim` invocation.
 */
export function shouldFlushAfter(eventType: string): boolean {
  return eventType === "SessionEnd";
}
