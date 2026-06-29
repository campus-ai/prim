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

function emit(): void {
  process.stdout.write("{}\n");
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
