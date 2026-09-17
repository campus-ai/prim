#!/usr/bin/env node
/**
 * prim SessionEnd hook for Claude Code.
 *
 * Reads the SessionEnd JSON envelope from stdin, notifies the prim
 * daemon over its Unix socket so it can update presence, and emits an
 * empty JSON object on stdout.
 *
 * Fail-soft: daemon down / socket missing / malformed envelope all
 * silently emit `{}` and exit 0.
 */

import { daemonRequest } from "../daemon/client.js";
import { parseAgent } from "./agent.js";
import { shouldSuppressImportedCursorHandler } from "./cursor-coexistence.js";
import { readHookStdin } from "./hook-stdin.js";
import { normalizeEnvelope } from "./normalize.js";

const STDIN_TIMEOUT_MS = 1_000;
const DAEMON_TIMEOUT_MS = 250;

interface SessionEnvelope {
  session_id?: string;
  hook_event_name?: string;
}

function emit(): void {
  process.stdout.write("{}\n");
}

async function main(): Promise<void> {
  const agent = parseAgent(process.argv);
  let raw: string;
  try {
    raw = await readHookStdin(STDIN_TIMEOUT_MS);
  } catch {
    emit();
    return;
  }
  let envelope: SessionEnvelope;
  try {
    const incoming = JSON.parse(raw) as Record<string, unknown>;
    if (agent !== "cursor" && shouldSuppressImportedCursorHandler(incoming, "prim-session-end")) {
      emit();
      return;
    }
    envelope = normalizeEnvelope(incoming, agent) as SessionEnvelope;
  } catch {
    emit();
    return;
  }
  if (envelope.hook_event_name !== "SessionEnd") {
    emit();
    return;
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    emit();
    return;
  }
  await daemonRequest(
    "session_end",
    { sessionId: envelope.session_id },
    { timeoutMs: DAEMON_TIMEOUT_MS },
  );
  emit();
}

main().catch(() => {
  emit();
});
