#!/usr/bin/env node
/**
 * prim PreToolUse hook for Claude Code and Codex.
 *
 * Reads the PreToolUse JSON envelope from stdin, calls the server-side
 * conflict-check endpoint once for the proposed tool invocation,
 * and emits the agent's contract JSON document on stdout that either allows,
 * asks, or denies the tool call. Visible Codex verdicts also carry the
 * Primitive situation report; Decision digests have a dedicated prompt path.
 *
 * Three load-bearing invariants:
 *   1. STDOUT is exclusively the hook output JSON. Anything else lives on
 *      STDERR (which Claude Code surfaces as user-visible context on exit
 *      code 2, but is otherwise informational).
 *   2. Exit code is 0 on every happy / fail-open path. Non-zero exits cause
 *      Claude Code to treat the hook as broken, which is louder than we want.
 *   3. INFRASTRUCTURE failures NEVER block the user. Before a mutation can be
 *      identified, malformed or irrelevant input fails open silently. Once a
 *      mutation is identified, service failure or an unverified target fails
 *      open with a visible "not verified" warning, never a clean allow.
 *
 * Config knobs (env vars):
 *   PRIM_BYPASS=1                 — skip the check entirely
 *   PRIM_HOOK_MODE=block|warn|off — default `block`; `warn` demotes
 *                                   ask/deny to warn (telemetry only)
 *
 * Conflict policy is owned entirely by the server; the hook sends one bounded
 * request for the complete invocation and consumes the returned verdict.
 */

import { isRepoActive, repoSyncId } from "../lib/activation.js";
import { packageVersion } from "../lib/bin-path.js";
import { parseAgent } from "./agent.js";
import {
  appendCodexContext,
  hasVisibleCodexMessage,
  prepareCodexContext,
} from "./codex-context.js";
import { normalizeEnvelope } from "./normalize.js";
import {
  type CodexHookOutput,
  type ConflictCheckResult,
  type HermesHookOutput,
  type HookEnv,
  type HookOutput,
  buildCodexOutput,
  buildHermesOutput,
  buildHookOutput,
  demoteForMode,
  failOpenCodex,
  failOpenHermes,
  failOpenOutput,
  readHookMode,
} from "./pre-tool-use-scoring.js";
import {
  PREFLIGHT_PROTOCOL_VERSION,
  type PreflightRequest,
  boundedClientVersion,
  proposalFor,
  requestPreflight,
  resolvePreflightTargets,
  resultForPreflight,
  unverifiedResult,
} from "./preflight-v3.js";

const STDIN_TIMEOUT_MS = 1_000;

type PreToolUseInput = {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  extra?: { tool_call_id?: unknown };
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

// The agent is stable for the process (stamped into the install command), so
// resolve it once — both main() and its catch handler emit through it.
const agent = parseAgent(process.argv);

async function emit(output: HookOutput | CodexHookOutput | HermesHookOutput): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    try {
      process.stdout.write(`${JSON.stringify(output)}\n`, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

async function emitWithAcknowledgment(
  output: HookOutput | CodexHookOutput | HermesHookOutput,
  acknowledge?: (handedOff: boolean) => Promise<void>,
): Promise<void> {
  const handedOff = await emit(output);
  await acknowledge?.(handedOff);
}

// The silent fail-open shaped for the active agent: Claude explicitly allows;
// Codex and Hermes use an empty object (no block).
function failOpen(): HookOutput | CodexHookOutput | HermesHookOutput {
  if (agent === "hermes") return failOpenHermes();
  return agent === "codex" ? failOpenCodex() : failOpenOutput();
}

function invocationId(envelope: PreToolUseInput): string | undefined {
  const value = agent === "hermes" ? envelope.extra?.tool_call_id : envelope.tool_use_id;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function emitUnverified(message: string, envelope?: PreToolUseInput): Promise<void> {
  const result = unverifiedResult(message);
  if (agent === "hermes") {
    process.stderr.write(`[primitive] ${message}\n`);
    await emit(failOpenHermes());
  } else {
    let output =
      agent === "codex" ? buildCodexOutput("allow", [result]) : buildHookOutput("allow", [result]);
    if (agent === "codex" && typeof envelope?.session_id === "string" && envelope.session_id) {
      try {
        const context = await prepareCodexContext({
          cwd: envelope.cwd ?? process.cwd(),
          sessionId: envelope.session_id,
          includeDigest: false,
        });
        output = appendCodexContext(output, context.context);
        await emitWithAcknowledgment(output, context.acknowledge);
        return;
      } catch {
        // Preserve the existing unverified message if context augmentation fails.
      }
    }
    await emit(output);
  }
}

async function main(): Promise<void> {
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    await emit(failOpen());
    return;
  }
  let envelope: PreToolUseInput;
  try {
    envelope = normalizeEnvelope(
      JSON.parse(raw) as Record<string, unknown>,
      agent,
    ) as PreToolUseInput;
  } catch {
    await emit(failOpen());
    return;
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
  if (targets.paths.length === 0) {
    await emitUnverified(
      "mutation targets could not be determined; enforcement not verified",
      envelope,
    );
    return;
  }
  const binding = repoSyncId(cwd);
  const sessionId = envelope.session_id;
  const callId = invocationId(envelope);
  if (!binding || typeof sessionId !== "string" || !sessionId || !callId) {
    await emitUnverified("repository binding or tool invocation identity is unavailable", envelope);
    return;
  }
  const request: PreflightRequest = {
    protocolVersion: PREFLIGHT_PROTOCOL_VERSION,
    agent,
    clientMode: mode,
    clientVersion: boundedClientVersion(packageVersion()),
    sessionId,
    invocationId: callId,
    repoSyncId: binding,
    paths: targets.paths,
    coverage: targets.coverage,
    proposal: proposalFor(envelope.tool_input),
  };
  let result: ConflictCheckResult;
  try {
    const response = await requestPreflight(request);
    if (!response) {
      await emitUnverified("enforcement service returned an incompatible response", envelope);
      return;
    }
    result = resultForPreflight(response);
  } catch {
    await emitUnverified("enforcement service unavailable; change was not verified", envelope);
    return;
  }
  const aggregate = demoteForMode(
    result.verdict === "unavailable" ? "allow" : result.verdict,
    mode,
  );
  if (agent === "hermes" && (aggregate === "warn" || result.verdict === "unavailable")) {
    process.stderr.write(`[primitive] ${result.reason || result.unavailable}\n`);
  }
  let output =
    agent === "hermes"
      ? buildHermesOutput(aggregate, [result])
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
  await emit(failOpen());
});
