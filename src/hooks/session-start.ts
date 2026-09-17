#!/usr/bin/env node
/**
 * prim SessionStart hook for Claude Code and Codex.
 *
 * Reads the SessionStart JSON envelope from stdin, notifies the prim daemon
 * over its Unix socket so presence reflects the new session, and emits stdout.
 *
 * Under `--agent codex` it injects the Primitive situation report as
 * SessionStart developer context
 * (`hookSpecificOutput.additionalContext`) — the best-available analog to
 * Claude Code's statusLine: Codex's own `tui.status_line` renders built-in
 * items only, with no scriptable hook. Decision digests ride UserPromptSubmit
 * with Stop as a backstop. Claude Code instead uses SessionStart
 * for skill refresh, proactive decision guidance, and decision feedback.
 *
 * Fail-soft: daemon down / socket missing / malformed envelope never blocks
 * the hook. Claude keeps its historical empty fallback; Codex reports the
 * unavailable daemon state when it can identify the session.
 */

import { warmBinCache } from "../lib/bin-cache.js";
import { parseAgent } from "./agent.js";
import { shouldSuppressImportedCursorHandler } from "./cursor-coexistence.js";
import { buildHookOutput, handoffHookOutput } from "./decision-feedback-core.js";
import { readHookStdin } from "./hook-stdin.js";
import { processSessionStart } from "./session-start-core.js";

const STDIN_TIMEOUT_MS = 1_000;
let outputAttempted = false;

function emitOutput(output: object, acknowledge?: () => Promise<unknown>): Promise<boolean> {
  outputAttempted = true;
  return handoffHookOutput(output, acknowledge);
}

async function main(): Promise<void> {
  // Refresh from the exact running package once per session so later Git hook
  // calls can bypass npx without introducing a mutable dist-tag execution.
  warmBinCache();
  const agent = parseAgent(process.argv);
  let raw: string;
  try {
    raw = await readHookStdin(STDIN_TIMEOUT_MS);
  } catch {
    await emitOutput(buildHookOutput({}));
    return;
  }
  if (agent !== "cursor") {
    try {
      const incoming = JSON.parse(raw) as Record<string, unknown>;
      if (shouldSuppressImportedCursorHandler(incoming, "prim-session-start")) {
        await emitOutput({});
        return;
      }
    } catch {
      // processSessionStart owns the ordinary malformed-envelope fallback.
    }
  }
  const result = await processSessionStart(raw, agent);
  await emitOutput(result.output, result.acknowledge);
}

void main().catch(async () => {
  if (!outputAttempted) await emitOutput(buildHookOutput({}));
});
