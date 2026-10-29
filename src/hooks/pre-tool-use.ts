#!/usr/bin/env node
/**
 * prim PreToolUse hook for Claude Code and Codex.
 *
 * Reads the PreToolUse JSON envelope from stdin, polls the server-side
 * conflict-check endpoint for the proposed tool invocation,
 * and emits the agent's contract JSON document on stdout that either allows,
 * asks, or denies the tool call. Visible Codex verdicts also carry the
 * Primitive situation report; Decision digests have a dedicated prompt path.
 *
 * STDOUT is exclusively host hook JSON. Active mutations require complete V4
 * evaluation; service failures and incomplete results pause the operation,
 * including in warn mode. PRIM_BYPASS=1 and PRIM_HOOK_MODE=off remain explicit
 * local opt-outs. Completed semantic conflicts retain the configured mode.
 */

import { HttpError, resolveAuthCredential } from "../client.js";
import { observeDemoInvocation } from "../demo/isolation.js";
import { isRepoActive, repoSyncId } from "../lib/activation.js";
import { packageVersion } from "../lib/bin-path.js";
import { cachedCollectScopeAdmits } from "../lib/collect-scope.js";
import { currentBranch, githubRepositoryFullName } from "../lib/git.js";
import { parseAgent } from "./agent.js";
import { editPreview } from "./approval-copy.js";
import {
  appendCodexContext,
  hasVisibleCodexMessage,
  prepareCodexContext,
} from "./codex-context.js";
import { shouldSuppressImportedCursorHandler } from "./cursor-coexistence.js";
import { readHookStdin } from "./hook-stdin.js";
import { normalizeEnvelope } from "./normalize.js";
import {
  type CodexHookOutput,
  type ConflictCheckResult,
  type ConflictVerdict,
  type CursorHookOutput,
  type HermesHookOutput,
  type HookEnv,
  type HookOutput,
  buildCodexOutput,
  buildCursorOutput,
  buildHermesOutput,
  buildHookOutput,
  demoteForMode,
  failOpenCodex,
  failOpenCursor,
  failOpenHermes,
  failOpenOutput,
  readHookMode,
} from "./pre-tool-use-scoring.js";
import { boundedClientVersion, proposalFor, resolvePreflightTargets } from "./preflight-v3.js";

import {
  PREFLIGHT_PROTOCOL_VERSION,
  PREFLIGHT_WAIT_MS,
  PreflightPausedError,
  type PreflightRequest,
  hasCompleteCoverage,
  pausedResult,
  resultForPreflight,
  toolInputDigest,
  waitForPreflight,
} from "./preflight-v4.js";

const STDIN_TIMEOUT_MS = 1_000;
const deadline =
  performance.now() + Math.max(0, PREFLIGHT_WAIT_MS - Math.ceil(process.uptime() * 1_000));
let activeMutation = false;

type PreToolUseInput = {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  extra?: { tool_call_id?: unknown };
  cwd?: string;
};

// The agent is stable for the process (stamped into the install command), so
// resolve it once — both main() and its catch handler emit through it.
const agent = parseAgent(process.argv);

async function emit(
  output: HookOutput | CodexHookOutput | CursorHookOutput | HermesHookOutput,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    try {
      process.stdout.write(`${JSON.stringify(output)}\n`, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

async function emitWithAcknowledgment(
  output: HookOutput | CodexHookOutput | CursorHookOutput | HermesHookOutput,
  acknowledge?: (handedOff: boolean) => Promise<void>,
): Promise<void> {
  const handedOff = await emit(output);
  await acknowledge?.(handedOff);
}

// The silent fail-open shaped for the active agent: Claude explicitly allows;
// Codex and Hermes use an empty object (no block).
function failOpen(): HookOutput | CodexHookOutput | CursorHookOutput | HermesHookOutput {
  if (agent === "hermes") return failOpenHermes();
  if (agent === "cursor") return failOpenCursor();
  return agent === "codex" ? failOpenCodex() : failOpenOutput();
}

function invocationId(envelope: PreToolUseInput): string | undefined {
  const value = agent === "hermes" ? envelope.extra?.tool_call_id : envelope.tool_use_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function hermesAdvisory(result: ConflictCheckResult, aggregate: ConflictVerdict): string {
  const parts: string[] = [];
  if (aggregate === "warn") parts.push(result.reason);
  if (result.verdict === "unavailable") {
    parts.push(result.unavailable ?? result.reason);
  }
  if (result.additionalContext && result.additionalContext !== result.reason) {
    parts.push(result.additionalContext);
  }
  const message = [...new Set(parts.filter(Boolean))].join("\n");
  return message.startsWith("[primitive]") ? message : message ? `[primitive] ${message}` : "";
}

// A 401 is a local credential problem with a known fix, not a service outage.
// A rejected PRIM_TOKEN outranks the token file, so `prim auth login` can't fix it.
function preflightFailure(error: unknown): string {
  if (!(error instanceof HttpError && error.status === 401)) {
    return "enforcement service unavailable; change was not verified";
  }
  if (resolveAuthCredential()?.source === "environment") {
    return "PRIM_TOKEN was rejected; change was not verified";
  }
  return "authentication required; run `prim auth login`; change was not verified";
}

async function emitUnverified(message: string, checkId?: string): Promise<void> {
  const result = pausedResult(message, checkId);
  const output =
    agent === "hermes"
      ? buildHermesOutput("deny", [result])
      : agent === "cursor"
        ? buildCursorOutput("deny", [result])
        : agent === "codex"
          ? buildCodexOutput("deny", [result])
          : buildHookOutput("deny", [result]);
  await emit(output);
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readHookStdin(STDIN_TIMEOUT_MS);
  } catch {
    await emit(failOpen());
    return;
  }
  let envelope: PreToolUseInput;
  try {
    const incoming = JSON.parse(raw) as Record<string, unknown>;
    if (agent !== "cursor" && shouldSuppressImportedCursorHandler(incoming, "prim-pre-tool-use")) {
      await emit(failOpenCursor());
      return;
    }
    envelope = normalizeEnvelope(incoming, agent) as PreToolUseInput;
  } catch {
    await emit(failOpen());
    return;
  }
  try {
    if (observeDemoInvocation(envelope as Record<string, unknown>, agent, false).invocation) {
      await emit(failOpen());
      return;
    }
  } catch {
    // An invalid tour acknowledgment grants no exemption from real enforcement.
  }
  if (envelope.hook_event_name !== "PreToolUse") {
    await emit(failOpen());
    return;
  }
  const env = process.env as HookEnv;
  const mode = readHookMode(env);
  if (mode === "off") {
    await emit(failOpen());
    return;
  }
  const toolName = typeof envelope.tool_name === "string" ? envelope.tool_name : "";
  const cwd =
    typeof envelope.cwd === "string" && envelope.cwd.length > 0 ? envelope.cwd : process.cwd();
  const targets = resolvePreflightTargets({
    toolName,
    toolInput: envelope.tool_input,
    agent,
    cwd,
  });
  if (targets.mutation === "none") {
    await emit(failOpen());
    return;
  }
  if (!isRepoActive(cwd)) {
    await emit(failOpen());
    return;
  }
  if (targets.paths.length === 0 && !targets.definite) {
    await emit(failOpen());
    return;
  }
  activeMutation = true;
  if (agent === "cursor" && targets.coverage === "unverified") {
    await emitUnverified("tool targets were ambiguous or outside the active repository");
    return;
  }
  const binding = repoSyncId(cwd);
  const branch = currentBranch(cwd);
  const sessionId = envelope.session_id;
  const callId = invocationId(envelope);
  if (!binding || typeof sessionId !== "string" || !sessionId || !callId) {
    await emitUnverified(
      "GitHub repo connection is required for repository-specific file attribution, Conflict Gate verification, and commit correlation; or tool invocation identity is unavailable",
    );
    return;
  }
  const collectScopeAdmits = cachedCollectScopeAdmits(cwd, {
    repository: githubRepositoryFullName(cwd) ?? undefined,
    branch,
    agent,
    paths: targets.paths,
    pathsComplete: targets.coverage === "complete",
  });
  const request: PreflightRequest = {
    protocolVersion: PREFLIGHT_PROTOCOL_VERSION,
    operation: "start",
    toolInputDigest: toolInputDigest(toolName, envelope.tool_input),
    agent,
    clientMode: mode,
    clientVersion: boundedClientVersion(packageVersion()),
    sessionId,
    invocationId: callId,
    repoSyncId: binding,
    paths: targets.paths,
    coverage: targets.coverage,
    ...(branch === undefined ? {} : { branch }),
    proposal: collectScopeAdmits ? proposalFor(envelope.tool_input) : "",
  };
  let result: ConflictCheckResult;
  try {
    const response = await waitForPreflight(request, {
      deadline,
      onProgress: ({ evaluationCoverage: coverage }) => {
        process.stderr.write(
          `[primitive] Checking Decisions: ${coverage.evaluatedCount + coverage.bypassedCount}/${coverage.candidateCount}${coverage.discoveryComplete ? "" : "+"} covered.\n`,
        );
      },
    });
    if (!hasCompleteCoverage(response)) {
      await emitUnverified(response.message || response.reasonCode, response.checkId);
      return;
    }
    result = resultForPreflight(
      response,
      editPreview(toolName, envelope.tool_input, targets.paths),
    );
  } catch (error) {
    await emitUnverified(
      error instanceof PreflightPausedError ? error.message : preflightFailure(error),
      error instanceof PreflightPausedError ? error.checkId : undefined,
    );
    return;
  }
  const aggregate = demoteForMode(result.verdict === "unavailable" ? "deny" : result.verdict, mode);
  if (agent === "hermes" && aggregate !== "deny" && aggregate !== "ask") {
    const advisory = hermesAdvisory(result, aggregate);
    if (advisory) process.stderr.write(`${advisory}\n`);
  }
  let output =
    agent === "hermes"
      ? buildHermesOutput(aggregate, [result])
      : agent === "cursor"
        ? buildCursorOutput(aggregate, [result])
        : agent === "codex"
          ? buildCodexOutput(aggregate, [result])
          : buildHookOutput(aggregate, [result]);
  if (
    agent === "codex" &&
    hasVisibleCodexMessage(output) &&
    typeof sessionId === "string" &&
    sessionId.length > 0
  ) {
    try {
      const context = await prepareCodexContext({ cwd, sessionId, includeDigest: false });
      output = appendCodexContext(output, context.context);
      await emitWithAcknowledgment(output, context.acknowledge);
      return;
    } catch {
      // The conflict verdict remains authoritative if status context fails.
    }
  }
  await emit(output);
}

main().catch(async () => {
  if (activeMutation) await emitUnverified("The Decision check could not complete");
  else await emit(failOpen());
});
