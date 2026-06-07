#!/usr/bin/env node
/**
 * prim PreToolUse hook for Claude Code (M3).
 *
 * Reads the PreToolUse JSON envelope from stdin, calls the server-side
 * conflict-check endpoint for each file path the proposed tool would
 * touch, and emits a Claude-Code-contract JSON document on stdout that
 * either allows, asks, or denies the tool call.
 *
 * Three load-bearing invariants:
 *   1. STDOUT is exclusively the hook output JSON. Anything else lives
 *      on STDERR (which Claude Code surfaces as user-visible context on
 *      exit code 2, but is otherwise informational).
 *   2. Exit code is 0 on every happy / fail-open path. Non-zero exits
 *      cause Claude Code to treat the hook as broken, which is louder
 *      than we want except for the explicit "show this stderr to the
 *      user" path (exit 2, not used in V1).
 *   3. Hook failures NEVER block the user. Network outage, malformed
 *      stdin, expired bearer token — all silently emit
 *      `permissionDecision: "allow"`. Hooks must fail open.
 *
 * Config knobs (env vars):
 *   PRIM_BYPASS=1                 — skip the check entirely
 *   PRIM_HOOK_MODE=block|warn|off — default `block`; `warn` demotes
 *                                   ask/deny to warn (telemetry only)
 *   PRIM_HOOK_FANOUT_THRESHOLD=N  — default 3
 *   PRIM_HOOK_DENY_REVERSIBILITY=low|high — default low
 *
 * Plan: ~/.claude/plans/great-i-d-like-for-joyful-hollerith.md (M3).
 */

import { getClient } from "../client.js";
import { daemonRequest } from "../daemon/client.js";
import {
  type ConflictCheckResult,
  type HookEnv,
  aggregateCheckResults,
  buildHookOutput,
  demoteForMode,
  extractFilePaths,
  failOpenOutput,
  readDenyReversibility,
  readFanOutThreshold,
  readHookMode,
} from "./pre-tool-use-scoring.js";

const HOOK_TIMEOUT_MS = 4_500;
const STDIN_TIMEOUT_MS = 1_000;
const DAEMON_TIMEOUT_MS = 250;

type PreToolUseInput = {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
};

async function readStdin(): Promise<string> {
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

function emit(output: ReturnType<typeof failOpenOutput>): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

async function checkOneFile(
  file: string,
  toolName: string,
  fanOutThreshold: number,
  denyReversibility: "low" | "high",
): Promise<ConflictCheckResult> {
  const params = { file, toolName, fanOutThreshold, denyReversibility };
  // M4: try the daemon first. It holds an open keep-alive connection +
  // amortizes token refresh, so a hit returns in ~20-30ms instead of the
  // ~200ms cold HTTP path. Null fall-through keeps users without a
  // running daemon on the original code path.
  const fromDaemon = await daemonRequest<ConflictCheckResult>("conflict_check", params, {
    timeoutMs: DAEMON_TIMEOUT_MS,
  });
  if (fromDaemon) {
    return fromDaemon;
  }
  const client = getClient();
  return (await client.post("/api/cli/decisions/conflict-check", params, {
    signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
  })) as ConflictCheckResult;
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit(failOpenOutput());
    return;
  }
  let envelope: PreToolUseInput;
  try {
    envelope = JSON.parse(raw) as PreToolUseInput;
  } catch {
    emit(failOpenOutput());
    return;
  }
  if (envelope.hook_event_name !== "PreToolUse") {
    emit(failOpenOutput());
    return;
  }
  const env = process.env as HookEnv;
  const mode = readHookMode(env);
  if (mode === "off") {
    emit(failOpenOutput());
    return;
  }
  const toolName = typeof envelope.tool_name === "string" ? envelope.tool_name : "";
  const files = extractFilePaths(toolName, envelope.tool_input);
  if (files.length === 0) {
    emit(failOpenOutput());
    return;
  }
  const fanOutThreshold = readFanOutThreshold(env);
  const denyReversibility = readDenyReversibility(env);
  let results: ConflictCheckResult[];
  try {
    results = await Promise.all(
      files.map((f) => checkOneFile(f, toolName, fanOutThreshold, denyReversibility)),
    );
  } catch {
    emit(failOpenOutput());
    return;
  }
  const rawAggregate = aggregateCheckResults(results);
  const aggregate = demoteForMode(rawAggregate, mode);
  emit(buildHookOutput(aggregate, results));
}

main().catch(() => {
  emit(failOpenOutput());
});
