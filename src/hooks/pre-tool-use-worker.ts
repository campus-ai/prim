#!/usr/bin/env node
/** Evaluation worker. Claude uses bounded V3; other agents retain V4. */

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
  PREFLIGHT_TIMEOUT_MS,
  type PreflightRequest as PreflightRequestV3,
  boundedClientVersion,
  proposalFor,
  proposalIsTruncated,
  requestPreflight,
  resolvePreflightTargets,
  resultForPreflight as resultForPreflightV3,
  unverifiedResult,
} from "./preflight-v3.js";

import {
  PREFLIGHT_PROTOCOL_VERSION,
  type PreflightRequest,
  hasConfirmedConflict,
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

async function unverified(message: string): Promise<void> {
  if (agent === "claude_code") {
    await emit(
      buildHookOutput("allow", [unverifiedResult(`${message}; change was not verified.`)]),
      true,
    );
  } else {
    await emit(failOpen());
  }
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
  const protectedShell = (agent === "claude_code" || agent === "codex") && toolName === "Bash";
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
  if (agent === "claude_code" && targets.paths.length === 0) {
    await unverified("Mutation targets could not be resolved");
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
    await unverified(
      !binding ? "GitHub repo connection is required" : "Session or tool identity is missing",
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
  const common = {
    agent,
    clientMode: mode,
    clientVersion: boundedClientVersion(packageVersion()),
    sessionId,
    invocationId: callId,
    repoSyncId: binding,
    paths: targets.paths,
    coverage: targets.coverage,
    ...(branch === undefined ? {} : { branch }),
    proposal: collectScopeAdmits ? proposalFor(proposalInput) : "",
  };
  if (agent === "claude_code") {
    const request: PreflightRequestV3 = { ...common, protocolVersion: 3 };
    let result: ConflictCheckResult;
    try {
      const remaining = Math.floor(Math.min(PREFLIGHT_TIMEOUT_MS, deadline - performance.now()));
      if (remaining <= 0) throw new Error("Deadline exceeded");
      const response = await requestPreflight(request, AbortSignal.timeout(remaining));
      if (!response) {
        await unverified("Decision check returned an invalid response");
        return;
      }
      result = resultForPreflightV3(
        response,
        editPreview(toolName, envelope.tool_input, targets.paths),
        request,
        collectScopeAdmits && protectedShell && proposalIsTruncated(proposalInput),
      );
      if (result.verdict === "unavailable") {
        result.unavailable = `${result.unavailable || "Decision check is unavailable"}; change was not verified.`;
      }
      const coverage = response.evaluationCoverage;
      const notes = [
        ...(targets.coverage === "unverified"
          ? [
              "[primitive] Some mutation targets could not be resolved; the complete change was not verified.",
            ]
          : []),
        ...(coverage &&
        (coverage.status !== "completed" ||
          coverage.selectionOmissions?.length ||
          coverage.evidenceOmissions?.length)
          ? [
              "[primitive] Decision coverage is incomplete; some candidates or evidence were not evaluated.",
            ]
          : []),
      ];
      if (notes.length > 0) {
        const note = notes.join("\n");
        result.reason = [result.reason, note].filter(Boolean).join("\n");
        result.additionalContext = [result.additionalContext, note].filter(Boolean).join("\n");
      }
    } catch {
      await unverified("Decision check failed or timed out");
      return;
    }
    await emit(
      buildHookOutput(
        demoteForMode(result.verdict === "unavailable" ? "allow" : result.verdict, mode),
        [result],
      ),
      true,
    );
    return;
  }
  const request: PreflightRequest = {
    ...common,
    protocolVersion: PREFLIGHT_PROTOCOL_VERSION,
    operation: "start",
    toolInputDigest: toolInputDigest(toolName, envelope.tool_input),
    ...(protectedShell
      ? {
          shellCheck: {
            targetMode:
              targets.coverage === "complete" ? ("files" as const) : ("repository" as const),
          },
        }
      : {}),
  };
  let result: ConflictCheckResult;
  try {
    const response = await waitForPreflight(request, {
      deadline,
      stopOnConflict: true,
    });
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
  } catch {
    await emit(failOpen());
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
  await emit(failOpen());
});
