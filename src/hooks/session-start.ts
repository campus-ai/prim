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
 * for. Claude Code instead uses SessionStart for skill refresh, proactive
 * decision guidance, and decision feedback. The count is injected only when
 * the daemon returns a live value; it is never fabricated.
 *
 * Fail-soft: daemon down / socket missing / malformed envelope all silently
 * emit `{}` and exit 0. Hooks must never block.
 */

import { FEEDBACK_DEADLINE_MS } from "../decisions/feedback.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { parseAgent } from "./agent.js";
import { buildHookOutput, handoffHookOutput } from "./decision-feedback-core.js";
import { processSessionStart } from "./session-start-core.js";

const STDIN_TIMEOUT_MS = 1_000;
let outputAttempted = false;

function emitOutput(
  output: ReturnType<typeof buildHookOutput>,
  acknowledge?: () => Promise<unknown>,
): Promise<boolean> {
  outputAttempted = true;
  return handoffHookOutput(output, acknowledge);
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

async function main(): Promise<void> {
  const feedbackSignal = AbortSignal.timeout(FEEDBACK_DEADLINE_MS);
  // SessionStart runs the bare ladder (cacheRead:false), so it always resolves
  // @latest fresh — the authoritative once-per-session refresh of the bin cache.
  warmBinCache();
  const agent = parseAgent(process.argv);
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    await emitOutput(buildHookOutput({}));
    return;
  }
  const result = await processSessionStart(raw, agent, feedbackSignal);
  await emitOutput(result.output, result.acknowledge);
}

void main().catch(async () => {
  if (!outputAttempted) await emitOutput(buildHookOutput({}));
});
