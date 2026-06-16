/**
 * Decision Event Pipeline — pure capture core.
 *
 * The mapping from a raw Claude Code hook event onto a Move envelope, and
 * the policy for when a capture should trigger a background drain. Kept
 * free of I/O so the wire mapping can be unit-pinned: a silent rename of a
 * Claude Code field (e.g. hook_event_name) would otherwise zero the
 * pipeline invisibly.
 */
import { randomUUID } from "node:crypto";
import { platform } from "node:os";
import { ENVELOPE_VERSION, type Move } from "../protocol/move.js";
import type { Agent } from "./agent.js";

export function toMove(
  parsed: Record<string, unknown>,
  cliVersion: string,
  agent: Agent = "claude_code",
): Move {
  return {
    moveId: randomUUID(),
    capturedAt: Date.now(),
    sessionId: (parsed.session_id as string | undefined) ?? "",
    eventType: (parsed.hook_event_name as string | undefined) ?? "unknown",
    payload: parsed,
    env: {
      cwd: (parsed.cwd as string | undefined) ?? process.cwd(),
      cliVersion,
      osPlatform: platform(),
    },
    envelopeVersion: ENVELOPE_VERSION,
    // Stamp the producer only for Codex; Claude Code moves omit it (the
    // backend defaults an absent value to "claude_code"), keeping the
    // Claude wire shape byte-identical.
    ...(agent === "codex" ? { producer: "codex" as const } : {}),
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
