#!/usr/bin/env node
/**
 * prim PostToolUse hook for Claude Code (M6).
 *
 * Captures Edit / Write / MultiEdit completions as `moves` rows. The
 * server-side extractor / classifier / linker pipeline (M5) consumes
 * the moves and produces `decisions` rows. The daemon (M4) subscribes
 * to `capturedRecent` (M6 server) and emits image #2's "broadcast →
 * N agents · <names>" line right after each new decision lands.
 *
 * Fail-soft: every failure path exits 0 with empty JSON on stdout.
 *
 * AX contract: STDOUT is `{}\n`. STDERR is silent unless
 * `PRIM_HOOK_VERBOSE=1`.
 */

import { getClient } from "../client.js";

const STDIN_TIMEOUT_MS = 1_000;
const INGEST_TIMEOUT_MS = 4_000;

const EDITING_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

interface PostToolUseEnvelope {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_response?: unknown;
}

interface MoveEnvelope {
  moveId: string;
  capturedAt: number;
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
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

function debug(msg: string): void {
  if (process.env.PRIM_HOOK_VERBOSE === "1") {
    process.stderr.write(`[prim-post-tool-use] ${msg}\n`);
  }
}

function buildMoveId(): string {
  return `pthook-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

async function ingestMove(move: MoveEnvelope): Promise<void> {
  const client = getClient();
  await client.post(
    "/api/cli/moves/ingest",
    { batch: [move] },
    { signal: AbortSignal.timeout(INGEST_TIMEOUT_MS) },
  );
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit();
    return;
  }
  let envelope: PostToolUseEnvelope;
  try {
    envelope = JSON.parse(raw) as PostToolUseEnvelope;
  } catch {
    emit();
    return;
  }
  if (envelope.hook_event_name !== "PostToolUse") {
    emit();
    return;
  }
  const toolName = typeof envelope.tool_name === "string" ? envelope.tool_name : "";
  if (!EDITING_TOOLS.has(toolName)) {
    emit();
    return;
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    emit();
    return;
  }
  const move: MoveEnvelope = {
    moveId: buildMoveId(),
    capturedAt: Date.now(),
    sessionId: envelope.session_id,
    eventType: "PostToolUse",
    payload: {
      tool_name: toolName,
      tool_input: envelope.tool_input,
      tool_response: envelope.tool_response,
    },
  };
  try {
    await ingestMove(move);
    debug(`ingested ${move.moveId} (${toolName})`);
  } catch (err) {
    debug(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  emit();
}

main().catch(() => {
  emit();
});
