#!/usr/bin/env node
/**
 * prim-hook — passive coding-agent event collector (Claude Code and Codex).
 *
 * Reads a single hook event from stdin, scrubs PII/secrets, wraps it in a
 * Move envelope, resolves its owning org, appends to that org's local
 * NDJSON journal, exits 0. On Claude Stop it also leases any eventual
 * same-worktree Decision feedback and returns it as a human-visible
 * systemMessage. For Codex, UserPromptSubmit also injects the daemon-cached
 * organization Decision digest on every message, with Stop as a guarded
 * continuation backstop. Capture and delivery fail independently.
 *
 * On a session-terminal event it spawns a detached `prim moves flush` so
 * the session's captured moves drain promptly — without dragging the
 * auth/HTTP subsystem into this per-tool-call cold path. The binding
 * resolver and the redaction filter are pure file IO, so they stay
 * cold-path-safe.
 *
 * Installed via: prim claude install
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOrg } from "../binding.js";
import {
  FEEDBACK_DEADLINE_MS,
  acknowledgeDecisionFeedback,
  leaseDecisionFeedback,
  renderFeedback,
} from "../decisions/feedback.js";
import { appendMove } from "../journal.js";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { resolveRepositoryContext } from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import { parseAgent } from "./agent.js";
import { processCodexMessageContext } from "./codex-message-context.js";
import { buildHookOutput, handoffHookOutput } from "./decision-feedback-core.js";
import { enrichHookPayloadWithFileRefs, preserveHookFileMetadata } from "./file-refs.js";
import { normalizeEnvelope } from "./normalize.js";
import { postToolInvocationId, shouldFlushAfter, toMove } from "./prim-hook-core.js";
import { scrubFromCwd } from "./redact.js";

const here = dirname(fileURLToPath(import.meta.url));
let outputAttempted = false;

function emitOutput(output: object, acknowledge?: () => Promise<unknown>): Promise<boolean> {
  outputAttempted = true;
  return handoffHookOutput(output, acknowledge);
}

function resolveCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function spawnBackgroundFlush(): void {
  const entry = join(here, "..", "index.js");
  spawn(process.execPath, [entry, "moves", "flush"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

function debug(area: "capture" | "feedback", error: unknown): void {
  if (!process.env.PRIM_HOOK_DEBUG) return;
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[prim-hook] ${area} failed: ${detail}\n`);
}

async function main(): Promise<void> {
  // One absolute budget covers every feedback auth/HTTP operation after this
  // point. It cannot preempt Node startup or synchronous filesystem work; see
  // the README's explicit timeout boundary.
  const feedbackSignal = AbortSignal.timeout(FEEDBACK_DEADLINE_MS);
  // Refresh the resolved-path cache so subsequent hook fires skip npx (no-op on
  // the cache-hit path and under the kill switch; never throws).
  warmBinCache();
  const agent = parseAgent(process.argv);
  let raw: string;
  let parsed: Record<string, unknown>;
  try {
    raw = readFileSync(0, "utf-8");
    parsed = normalizeEnvelope(JSON.parse(raw) as Record<string, unknown>, agent);
  } catch (error) {
    debug("capture", error);
    await emitOutput(buildHookOutput({}));
    return;
  }
  // Normalize Hermes event names into prim's internal vocabulary at the wire
  // boundary (a no-op for Claude Code / Codex), so eventType and the
  // shouldFlushAfter drain trigger key on the names every downstream guard
  // already expects.
  const cwd = (parsed.cwd as string | undefined) ?? process.cwd();
  // Opt-in gate: capture only in repos where prim is activated (prim.active).
  // Inactive repos short-circuit here — nothing is built, journaled, or flushed
  // — so a machine-wide (user-scope) install never captures where unwanted.
  const isClaudeStop = agent === "claude_code" && parsed.hook_event_name === "Stop";
  const isCodexContextEvent =
    agent === "codex" &&
    (parsed.hook_event_name === "UserPromptSubmit" || parsed.hook_event_name === "Stop");
  if (!isRepoActiveForCapture(cwd)) {
    if (isClaudeStop || isCodexContextEvent) await emitOutput(buildHookOutput({}));
    return;
  }

  const identity = getOrCreateWorkspaceId(cwd);
  const workspaceId = identity.status === "ready" ? identity.workspaceId : undefined;
  const resolvedRepository = resolveRepositoryContext(cwd);
  const repository = resolvedRepository
    ? { ...resolvedRepository, repoSyncId: repoSyncId(cwd) }
    : null;

  try {
    // Derive the envelope's identity/control fields (sessionId, eventType,
    // env.cwd) from the (normalized) event so org binding is provably
    // independent of redaction, then scrub ONLY the payload body that persists
    // to the journal, transits to the server, and lands in the moves table.
    // Canonical refs are authoritative on every captured tool event. In
    // particular, PreToolUse can be selected as Decision evidence on its own;
    // leaving it raw would let the backend recreate a lexical ref that the
    // synchronous gate (or PostToolUse) rejected as a symlink/root escape.
    // Non-tool events expose no paths and pass through byte-for-byte.
    const enrichment = repository
      ? enrichHookPayloadWithFileRefs({ parsed, agent, cwd, repository })
      : undefined;
    const enriched = enrichment?.parsed ?? parsed;
    const invocationId = postToolInvocationId(enriched, agent);
    const base = toMove(
      enriched,
      resolveCliVersion(),
      agent,
      workspaceId,
      repository,
      invocationId,
    );
    const scrubbed = scrubFromCwd(enriched, cwd);
    const move = {
      ...base,
      payload: enrichment ? preserveHookFileMetadata(scrubbed, enrichment.resolution) : scrubbed,
    };
    const { orgId } = resolveOrg({ sessionId: move.sessionId, cwd: move.env.cwd });
    appendMove(move, orgId);
    if (shouldFlushAfter(move.eventType)) {
      spawnBackgroundFlush();
    }
  } catch (error) {
    debug("capture", error);
  }

  if (isCodexContextEvent) {
    const result = await processCodexMessageContext(parsed);
    await emitOutput(result.output, result.acknowledge);
    return;
  }

  if (!isClaudeStop) return;
  const sessionId = typeof parsed.session_id === "string" ? parsed.session_id : "";
  if (!workspaceId || !sessionId) {
    await emitOutput(buildHookOutput({}));
    return;
  }

  const lease = await leaseDecisionFeedback(
    { workspaceId, currentSessionId: sessionId, signal: feedbackSignal },
    { onError: (error) => debug("feedback", error) },
  );
  const rendered = lease ? renderFeedback(lease) : undefined;
  await emitOutput(
    buildHookOutput({ systemMessage: rendered?.systemMessage }),
    rendered
      ? async () => {
          await acknowledgeDecisionFeedback(
            {
              protocolVersion: rendered.protocolVersion,
              workspaceId,
              deliveries: rendered.deliveries,
              signal: feedbackSignal,
            },
            { onError: (error) => debug("feedback", error) },
          );
        }
      : undefined,
  );
}

void main().catch(async (error: unknown) => {
  debug("capture", error);
  if (!outputAttempted) await emitOutput(buildHookOutput({}));
});
