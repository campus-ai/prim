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
 *   3. INFRASTRUCTURE failures NEVER block the user. Malformed input emits a
 *      bare allow; a network/auth failure emits allow plus an explicit
 *      "not verified" note when the agent has a context channel.
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

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getClient } from "../client.js";
import { isRepoActiveForCapture } from "../lib/activation.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { resolveRepositoryContext } from "../lib/git.js";
import { parseAgent } from "./agent.js";
import {
  MAX_PREFLIGHT_FILE_TARGETS,
  rejectedTargetWarning,
  resolveHookFileRefs,
} from "./file-refs.js";
import { normalizeEnvelope } from "./normalize.js";
import {
  type ConflictCheckResult,
  type HermesHookOutput,
  type HookEnv,
  type HookOutput,
  aggregateCheckResults,
  buildHermesOutput,
  buildHookOutput,
  demoteForMode,
  failOpenHermes,
  failOpenOutput,
  readHookMode,
  settledCheckResults,
} from "./pre-tool-use-scoring.js";
import {
  type ProposedChangePreview,
  conflictCheckV2Request,
  proposedChangePreview,
  shellMutationUnverifiedObservation,
} from "./proposed-change.js";

const HOOK_TIMEOUT_MS = 4_500;
const OBSERVATION_TIMEOUT_MS = 1_500;
const STDIN_TIMEOUT_MS = 1_000;
const here = dirname(fileURLToPath(import.meta.url));

type PreToolUseInput = {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  // Claude Code stamps the session working directory on every hook envelope;
  // we relativize absolute tool file paths against it before the lookup.
  cwd?: string;
};

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

function emit(output: HookOutput | HermesHookOutput): void {
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

// The silent fail-open shaped for the active agent: Claude/Codex speak the
// `hookSpecificOutput` allow; Hermes speaks an empty object (no block).
function failOpen(): HookOutput | HermesHookOutput {
  return agent === "hermes" ? failOpenHermes() : failOpenOutput();
}

async function checkOneFile(
  file: string,
  repoKey: string | undefined,
  proposedChange: ProposedChangePreview,
  cliVersion: string,
): Promise<ConflictCheckResult> {
  // V2 deliberately bypasses the daemon: an older long-lived daemon would
  // otherwise strip the semantic preview/repository identity and silently
  // downgrade this request to the v1 file-only policy.
  const client = getClient();
  return (await client.post(
    "/api/cli/decisions/conflict-check",
    conflictCheckV2Request(file, repoKey, proposedChange),
    {
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      quietRefresh: true,
      headers: {
        "x-primitive-agent": agent,
        "x-primitive-cli-version": cliVersion,
      },
    },
  )) as ConflictCheckResult;
}

async function observeUnverifiedShell(
  repoKey: string | undefined,
  cliVersion: string,
): Promise<void> {
  // This payload is deliberately metadata-only: the command and its content
  // are neither sent nor persisted when no deterministic target exists.
  await getClient().post(
    "/api/cli/decisions/preflight-observation",
    shellMutationUnverifiedObservation(repoKey),
    {
      signal: AbortSignal.timeout(OBSERVATION_TIMEOUT_MS),
      quietRefresh: true,
      headers: {
        "x-primitive-agent": agent,
        "x-primitive-cli-version": cliVersion,
      },
    },
  );
}

function unverifiedResult(detail: string): ConflictCheckResult {
  return {
    verdict: "unavailable",
    conflicts: [],
    reason: "",
    additionalContext: "",
    truncated: false,
    unavailable: detail,
  };
}

async function main(): Promise<void> {
  warmBinCache();
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit(failOpen());
    return;
  }
  let envelope: PreToolUseInput;
  try {
    envelope = normalizeEnvelope(
      JSON.parse(raw) as Record<string, unknown>,
      agent,
    ) as PreToolUseInput;
  } catch {
    emit(failOpen());
    return;
  }
  if (envelope.hook_event_name !== "PreToolUse") {
    emit(failOpen());
    return;
  }
  const env = process.env as HookEnv;
  const mode = readHookMode(env);
  if (mode === "off") {
    emit(failOpen());
    return;
  }
  const toolName = typeof envelope.tool_name === "string" ? envelope.tool_name : "";
  const cwd =
    typeof envelope.cwd === "string" && envelope.cwd.length > 0 ? envelope.cwd : process.cwd();
  // Opt-in gate: only run the conflict check in repos where prim is activated
  // (prim.active); fail open (allow) when inactive.
  if (!isRepoActiveForCapture(cwd)) {
    emit(failOpen());
    return;
  }
  const repository = resolveRepositoryContext(cwd);
  if (!repository) {
    emit(
      agent === "hermes"
        ? failOpenHermes()
        : buildHookOutput("allow", [unverifiedResult("not in a Git repository")], agent),
    );
    return;
  }

  const resolution = resolveHookFileRefs({
    toolName,
    toolInput: envelope.tool_input,
    agent,
    cwd,
    repository,
  });
  const localUnverified: ConflictCheckResult[] = [];
  for (const rejected of resolution.rejected) {
    localUnverified.push(unverifiedResult(rejectedTargetWarning(rejected.reason)));
  }
  if (resolution.targetsTruncated) {
    localUnverified.push(
      unverifiedResult(
        `file target list was truncated after ${String(MAX_PREFLIGHT_FILE_TARGETS)} paths; remaining mutations were not verified`,
      ),
    );
  }
  if (resolution.shellMutation === "unresolved" && !resolution.targetsTruncated) {
    localUnverified.push(
      unverifiedResult("shell mutation target could not be determined; enforcement not verified"),
    );
  }
  const cliVersion = resolveCliVersion();
  // Emit the metadata-only reason for every unresolved shell mutation,
  // including mixed commands where other literal targets can still be
  // checked normally. Start it alongside semantic preflights so diagnostics
  // never extend the hook's critical path.
  const observation =
    resolution.shellMutation === "unresolved"
      ? observeUnverifiedShell(repository.repoKey, cliVersion).catch(() => {
          // The local warning remains authoritative; telemetry is best effort.
        })
      : Promise.resolve();
  const files = resolution.fileRefs;
  if (files.length === 0) {
    if (resolution.shellMutation === "unresolved") {
      // The warning below is authoritative. Observation is best-effort and
      // must never turn telemetry availability into a shell block.
      await observation;
    }
    if (localUnverified.length === 0) emit(failOpen());
    else {
      emit(
        agent === "hermes" ? failOpenHermes() : buildHookOutput("allow", localUnverified, agent),
      );
    }
    return;
  }

  const change = proposedChangePreview(
    toolName,
    envelope.tool_input,
    cwd,
    agent,
    repository.repoRoot,
  );
  const [settled] = await Promise.all([
    Promise.allSettled(files.map((f) => checkOneFile(f, repository.repoKey, change, cliVersion))),
    observation,
  ]);
  const results = settledCheckResults(settled, () =>
    unverifiedResult("enforcement service unavailable; change was not verified"),
  );
  results.push(...localUnverified);
  const rawAggregate = aggregateCheckResults(results);
  const aggregate = demoteForMode(rawAggregate, mode);
  emit(
    agent === "hermes"
      ? buildHermesOutput(aggregate, results)
      : buildHookOutput(aggregate, results, agent),
  );
}

main().catch(() => {
  emit(failOpen());
});
