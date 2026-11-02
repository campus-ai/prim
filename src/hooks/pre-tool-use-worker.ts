#!/usr/bin/env node
/** Evaluation worker. Protected shell commands also pause when evaluation cannot finish. */

import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { observeDemoInvocation } from "../demo/isolation.js";
import { repoActiveFlag, repoSyncId } from "../lib/activation.js";
import { packageVersion } from "../lib/bin-path.js";
import { cachedCollectScopeAdmits } from "../lib/collect-scope.js";
import { canonicalGitRoot, currentBranch, githubRepositoryFullName } from "../lib/git.js";
import { parseAgent } from "./agent.js";
import { editPreview } from "./approval-copy.js";
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
import {
  boundedClientVersion,
  proposalFor,
  proposalIsTruncated,
  resolvePreflightTargets,
} from "./preflight-v3.js";

import {
  PREFLIGHT_PROTOCOL_VERSION,
  PreflightPausedError,
  type PreflightRequest,
  hasCompleteCoverage,
  hasConfirmedConflict,
  pausedResult,
  resultForPreflight,
  toolInputDigest,
  waitForPreflight,
} from "./preflight-v4.js";

const STDIN_TIMEOUT_MS = 1_000;
// The supervisor owns the process deadline, including all local preparation.
const deadline = performance.now() + Math.max(0, Number(process.argv.at(-1)) - Date.now());

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
  confirmed = false,
): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    try {
      process.stdout.write(`${JSON.stringify({ output, confirmed })}\n`, (error) =>
        resolve(!error),
      );
    } catch {
      resolve(false);
    }
  });
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

let protectedShell = false;
async function pause(message: string, checkId?: string): Promise<void> {
  const result = pausedResult(message, checkId);
  await emit(
    agent === "codex" ? buildCodexOutput("deny", [result]) : buildHookOutput("deny", [result]),
    true,
  );
}
async function main(): Promise<void> {
  const mode = readHookMode(process.env as HookEnv);
  if (mode === "off") {
    await emit(failOpen(), true);
    return;
  }
  let raw: string;
  try {
    raw = await readHookStdin(STDIN_TIMEOUT_MS);
  } catch {
    await emit(failOpen());
    return;
  }
  let envelope: PreToolUseInput;
  try {
    const incoming: unknown = JSON.parse(raw);
    if (!incoming || typeof incoming !== "object" || Array.isArray(incoming)) {
      throw new Error("The hook envelope must be an object");
    }
    const fields = incoming as Record<string, unknown>;
    if (agent !== "cursor" && shouldSuppressImportedCursorHandler(fields, "prim-pre-tool-use")) {
      await emit(failOpenCursor(), true);
      return;
    }
    envelope = normalizeEnvelope(fields, agent) as PreToolUseInput;
    if (typeof envelope.hook_event_name !== "string" || !envelope.hook_event_name) {
      throw new Error("The hook event identity is unavailable");
    }
  } catch {
    await emit(failOpen());
    return;
  }
  try {
    if (observeDemoInvocation(envelope as Record<string, unknown>, agent, false).invocation) {
      await emit(failOpen(), true);
      return;
    }
  } catch {
    // An invalid tour acknowledgment grants no exemption from real enforcement.
  }
  if (envelope.hook_event_name !== "PreToolUse") {
    await emit(failOpen(), true);
    return;
  }
  if (typeof envelope.tool_name !== "string" || !envelope.tool_name) {
    await emit(failOpen());
    return;
  }
  const toolName = envelope.tool_name;
  protectedShell = (agent === "claude_code" || agent === "codex") && toolName === "Bash";
  const cwd =
    typeof envelope.cwd === "string" && envelope.cwd.length > 0 ? envelope.cwd : process.cwd();
  const targets = resolvePreflightTargets({
    toolName,
    toolInput: envelope.tool_input,
    agent,
    cwd,
  });
  if (targets.mutation === "none") {
    await emit(failOpen(), true);
    return;
  }
  if (repoActiveFlag(cwd, protectedShell) !== "true") {
    await emit(failOpen(), true);
    return;
  }
  if (!protectedShell && targets.paths.length === 0 && !targets.definite) {
    await emit(failOpen());
    return;
  }
  if (agent === "cursor" && targets.coverage === "unverified") {
    await emit(failOpen());
    return;
  }
  const binding = repoSyncId(cwd);
  const branch = currentBranch(cwd);
  const sessionId = envelope.session_id;
  const callId = invocationId(envelope);
  if (!binding || typeof sessionId !== "string" || !sessionId || !callId) {
    if (protectedShell) {
      await pause("Repository or invocation identity is unavailable");
      return;
    }
    await emit(failOpen());
    return;
  }
  const collectScopeAdmits = cachedCollectScopeAdmits(cwd, {
    repository: githubRepositoryFullName(cwd) ?? undefined,
    branch,
    agent,
    paths: targets.paths,
    pathsComplete: targets.coverage === "complete",
  });
  const root = protectedShell ? canonicalGitRoot(cwd) : null;
  const proposalInput = protectedShell
    ? {
        ...(typeof envelope.tool_input === "string"
          ? { command: envelope.tool_input }
          : (envelope.tool_input as Record<string, unknown>)),
        repositoryCwd: root ? relative(root, realpathSync(cwd)).replaceAll("\\", "/") || "." : null,
        knownWritePaths: targets.paths,
        targetCoverage: targets.coverage,
      }
    : envelope.tool_input;
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
    ...(protectedShell
      ? {
          shellCheck: {
            targetMode:
              targets.coverage === "complete" ? ("files" as const) : ("repository" as const),
          },
        }
      : {}),
    ...(branch === undefined ? {} : { branch }),
    proposal: collectScopeAdmits ? proposalFor(proposalInput) : "",
  };
  let result: ConflictCheckResult;
  try {
    const response = await waitForPreflight(request, {
      deadline,
      stopOnConflict: !protectedShell,
    });
    if (
      protectedShell &&
      (!hasCompleteCoverage(response) ||
        (!hasConfirmedConflict(response) && response.verdict !== "allow") ||
        (response.evaluationCoverage.candidateCount > 0 && proposalIsTruncated(proposalInput)))
    ) {
      await pause(response.message || "Shell evaluation is incomplete", response.checkId);
      return;
    }
    if (!hasConfirmedConflict(response)) {
      await emit(failOpen(), true);
      return;
    }
    result = resultForPreflight(
      response,
      editPreview(toolName, envelope.tool_input, targets.paths),
      request,
      collectScopeAdmits &&
        (toolName === "Bash" || toolName === "Shell") &&
        proposalIsTruncated(proposalInput),
    );
  } catch (error) {
    if (protectedShell)
      await pause(
        "Shell evaluation is unavailable or exceeded the two-second deadline",
        error instanceof PreflightPausedError ? error.checkId : undefined,
      );
    else await emit(failOpen());
    return;
  }
  const aggregate = demoteForMode(result.verdict === "unavailable" ? "deny" : result.verdict, mode);
  if (agent === "hermes" && aggregate !== "deny" && aggregate !== "ask") {
    const advisory = hermesAdvisory(result, aggregate);
    if (advisory) process.stderr.write(`${advisory}\n`);
  }
  const output =
    agent === "hermes"
      ? buildHermesOutput(aggregate, [result])
      : agent === "cursor"
        ? buildCursorOutput(aggregate, [result])
        : agent === "codex"
          ? buildCodexOutput(aggregate, [result])
          : buildHookOutput(aggregate, [result]);

  await emit(output, true);
}

main().catch(async () => {
  if (protectedShell) await pause("Shell evaluation is unavailable");
  else await emit(failOpen());
});
