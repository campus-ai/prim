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
import { kickDaemonEnsure } from "../daemon/self-heal.js";
import {
  FEEDBACK_DEADLINE_MS,
  acknowledgeDecisionFeedback,
  leaseDecisionFeedback,
  renderFeedback,
} from "../decisions/feedback.js";
import { isRepoActiveForCapture } from "../lib/activation.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import { parseAgent } from "./agent.js";
import { buildHookOutput, handoffHookOutput } from "./decision-feedback-core.js";
import { normalizeEnvelope } from "./normalize.js";

const STDIN_TIMEOUT_MS = 1_000;
const DAEMON_TIMEOUT_MS = 250;
let outputAttempted = false;

function emitOutput(
  output: ReturnType<typeof buildHookOutput>,
  acknowledge?: () => Promise<unknown>,
): Promise<boolean> {
  outputAttempted = true;
  return handoffHookOutput(output, acknowledge);
}

interface SessionEnvelope {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
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
  let envelope: SessionEnvelope;
  try {
    envelope = normalizeEnvelope(
      JSON.parse(raw) as Record<string, unknown>,
      agent,
    ) as SessionEnvelope;
  } catch {
    await emitOutput(buildHookOutput({}));
    return;
  }
  if (envelope.hook_event_name !== "SessionStart") {
    await emitOutput(buildHookOutput({}));
    return;
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    await emitOutput(buildHookOutput({}));
    return;
  }
  // Repair or start the supervised daemon once per agent session. This is
  // intentionally detached: hook latency and output must never depend on
  // launchctl or network health, and `daemon ensure` honors an explicit stop.
  kickDaemonEnsure();
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
      await emitOutput(
        buildHookOutput({ additionalContext: `[prim] team: ${snapshot.onlineCount} online` }),
      );
      return;
    }
  }

  if (agent === "claude_code") {
    const cwd = envelope.cwd ?? process.cwd();
    if (isRepoActiveForCapture(cwd)) {
      const identity = getOrCreateWorkspaceId(cwd);
      if (identity.status === "ready") {
        const lease = await leaseDecisionFeedback({
          workspaceId: identity.workspaceId,
          currentSessionId: envelope.session_id,
          signal: feedbackSignal,
        });
        const rendered = lease ? renderFeedback(lease) : undefined;
        await emitOutput(
          buildHookOutput({ systemMessage: rendered?.systemMessage }),
          rendered
            ? async () => {
                await acknowledgeDecisionFeedback({
                  workspaceId: identity.workspaceId,
                  deliveries: rendered.deliveries,
                  signal: feedbackSignal,
                });
              }
            : undefined,
        );
        return;
      }
    }
  }

  await emitOutput(buildHookOutput({}));
}

void main().catch(async () => {
  if (!outputAttempted) await emitOutput(buildHookOutput({}));
});
