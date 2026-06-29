#!/usr/bin/env node
/**
 * prim SessionStart hook for Claude Code and Codex.
 *
 * Reads the SessionStart JSON envelope from stdin, notifies the prim daemon
 * over its Unix socket so presence reflects the new session, and emits stdout.
 *
 * Under `--agent codex` it also injects the team presence count as SessionStart
 * developer context (`hookSpecificOutput.additionalContext`) — the
 * best-available analog to Claude Code's statusLine, which Codex has no hook
 * for. Claude Code keeps the empty `{}` (it renders presence via the statusLine
 * block). The count is injected only when the daemon returns a live value; it
 * is never fabricated.
 *
 * Fail-soft: daemon down / socket missing / malformed envelope all silently
 * emit `{}` and exit 0. Hooks must never block.
 */

import { getSiteUrl } from "../client.js";
import { daemonRequest } from "../daemon/client.js";
import { parseAgent } from "./agent.js";
import { normalizeEnvelope } from "./normalize.js";

const STDIN_TIMEOUT_MS = 1_000;
const DAEMON_TIMEOUT_MS = 250;

interface SessionEnvelope {
  session_id?: string;
  hook_event_name?: string;
}

function readStdin(): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      reject(new Error("stdin read timeout"));
    }, STDIN_TIMEOUT_MS);
    process.stdin.on("data", (chunk: Buffer) => chunks.push(chunk));
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(Buffer.concat(chunks).toString("utf-8"));
    });
    process.stdin.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function emit(additionalContext?: string): void {
  if (!additionalContext) {
    process.stdout.write("{}\n");
    return;
  }
  const out = {
    hookSpecificOutput: {
      hookEventName: "SessionStart",
      additionalContext,
    },
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

async function main(): Promise<void> {
  const agent = parseAgent(process.argv);
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit();
    return;
  }
  let envelope: SessionEnvelope;
  try {
    envelope = normalizeEnvelope(
      JSON.parse(raw) as Record<string, unknown>,
      agent,
    ) as SessionEnvelope;
  } catch {
    emit();
    return;
  }
  if (envelope.hook_event_name !== "SessionStart") {
    emit();
    return;
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    emit();
    return;
  }
  await daemonRequest(
    "session_start",
    { sessionId: envelope.session_id },
    { timeoutMs: DAEMON_TIMEOUT_MS },
  );
  // Codex has no statusLine hook, so surface the team count as SessionStart
  // developer context instead — only when the daemon returns a live count.
  // (Hermes session hooks are observer-only — its presence count rides
  // pre_llm_call in prim-hook instead.)
  if (agent === "codex") {
    const snapshot = await daemonRequest<{ onlineCount?: number; presenceStale?: boolean }>(
      "status_snapshot",
      // callerEnv: a cross-env daemon withholds onlineCount, so a prod Codex
      // session never gets a staging daemon's team count injected.
      { callerEnv: getSiteUrl() },
      { timeoutMs: DAEMON_TIMEOUT_MS },
    );
    // Mirror the statusline's honest-presence rule: inject the count only when
    // the daemon has a fresh accepted ack — never a stale (frozen) count.
    if (snapshot && !snapshot.presenceStale && typeof snapshot.onlineCount === "number") {
      emit(`[prim] team: ${snapshot.onlineCount} online`);
      return;
    }
  }
  emit();
}

main().catch(() => {
  emit();
});
