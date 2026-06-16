#!/usr/bin/env node
/**
 * prim PreToolUse hook for Claude Code.
 *
 * Reads the PreToolUse JSON envelope from stdin, calls the server-side
 * conflict-check endpoint for each file path the proposed tool would touch,
 * and emits a Claude-Code-contract JSON document on stdout that either
 * allows, asks, or denies the tool call.
 *
 * Three load-bearing invariants:
 *   1. STDOUT is exclusively the hook output JSON. Anything else lives on
 *      STDERR (which Claude Code surfaces as user-visible context on exit
 *      code 2, but is otherwise informational).
 *   2. Exit code is 0 on every happy / fail-open path. Non-zero exits cause
 *      Claude Code to treat the hook as broken, which is louder than we want.
 *   3. INFRASTRUCTURE failures NEVER block the user. Network outage,
 *      malformed stdin, expired bearer token — all silently emit
 *      `permissionDecision: "allow"`. Hooks fail open on their own breakage.
 *      This is distinct from a server verdict of "unavailable" or a
 *      truncated conflict set: those mean the constraints are UNKNOWN and are
 *      surfaced as an honest "not verified" note, never a clean allow.
 *
 * Config knobs (env vars):
 *   PRIM_BYPASS=1                 — skip the check entirely
 *   PRIM_HOOK_MODE=block|warn|off — default `block`; `warn` demotes
 *                                   ask/deny to warn (telemetry only)
 *
 * Conflict-scoring policy (fan-out / reversibility thresholds) is owned
 * entirely by the server; the hook sends only the file path and consumes the
 * verdict it gets back.
 */

import { getClient } from "../client.js";
import {
  type ConflictCheckResult,
  type HookEnv,
  aggregateCheckResults,
  buildHookOutput,
  demoteForMode,
  extractFilePaths,
  failOpenOutput,
  readHookMode,
  toRepoRelative,
} from "./pre-tool-use-scoring.js";

const HOOK_TIMEOUT_MS = 4_500;
const STDIN_TIMEOUT_MS = 1_000;

type PreToolUseInput = {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  // Claude Code stamps the session working directory on every hook envelope;
  // we relativize absolute tool file paths against it before the lookup.
  cwd?: string;
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

async function checkOneFile(file: string): Promise<ConflictCheckResult> {
  const client = getClient();
  return (await client.post(
    "/api/cli/decisions/conflict-check",
    { file },
    { signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) },
  )) as ConflictCheckResult;
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
  const cwd =
    typeof envelope.cwd === "string" && envelope.cwd.length > 0 ? envelope.cwd : process.cwd();
  const files = extractFilePaths(toolName, envelope.tool_input).map((f) => toRepoRelative(f, cwd));
  if (files.length === 0) {
    emit(failOpenOutput());
    return;
  }
  let results: ConflictCheckResult[];
  try {
    results = await Promise.all(files.map((f) => checkOneFile(f)));
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
