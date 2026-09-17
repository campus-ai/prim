#!/usr/bin/env node
/**
 * prim post-tool outcome hook for Claude Code, Codex, and Hermes.
 *
 * Captures edit-tool completions and failures — Claude Code
 * Edit/Write/MultiEdit/NotebookEdit (including PostToolUseFailure), Codex
 * apply_patch, and Hermes write_file/patch plus approval denials (selected by
 * `--agent`) — as `moves` rows by POSTing them to the server's ingest endpoint,
 * where the extractor / classifier / linker pipeline turns them into decisions.
 * It writes the Move to the same durable journal first, then attempts
 * synchronous ingest so the server can return an immediate verdict footer
 * without making recovery depend on HTTP.
 *
 * The move carries canonical repository-relative file refs for server joins.
 * Its payload and username-bearing local path identity are scrubbed before
 * leaving the machine, matching the passive capture path.
 *
 * Fail-soft: every failure path exits 0 with empty JSON on stdout.
 *
 * AX contract: STDOUT is `{}\n`, with one exception — under `--agent codex`,
 * when the server returned a verdict footer, stdout carries the footer's
 * status context as `{"systemMessage": …}` so the visible Decision
 * moment also reaches the Codex transcript. STDERR is silent unless
 * PRIM_HOOK_VERBOSE=1, except for the verdict footer (a deliberate human
 * signal on STDERR).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOrg } from "../binding.js";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { cachedCollectScopeAdmits } from "../lib/collect-scope.js";
import { currentBranch, resolveRepositoryContext } from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Move } from "../protocol/move.js";
import { type Agent, parseAgent } from "./agent.js";
import { appendCodexContext, prepareCodexContext } from "./codex-context.js";
import { shouldSuppressImportedCursorHandler } from "./cursor-coexistence.js";
import { enrichHookPayloadWithFileRefs, preserveHookFileMetadata } from "./file-refs.js";
import { readHookStdin } from "./hook-stdin.js";
import { normalizeEnvelope } from "./normalize.js";
import { deliverPostToolMove } from "./post-tool-delivery.js";
import { postToolInvocationId, toMove, toolOutcomeFor } from "./prim-hook-core.js";
import { scrubFromCwd } from "./redact.js";
import { isVerdictFooterContext, renderVerdictFooter } from "./verdict-footer.js";

const STDIN_TIMEOUT_MS = 1_000;
const EDITING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
// Codex exposes both apply_patch and shell commands through tool hooks.
const CODEX_EDITING_TOOLS = new Set(["apply_patch", "Bash"]);
// Hermes routes file edits through write_file and patch.
const HERMES_EDITING_TOOLS = new Set(["write_file", "patch"]);
const CURSOR_EDITING_TOOLS = new Set(["Write", "Delete", "Shell"]);

function editingToolsFor(agent: Agent): Set<string> {
  if (agent === "codex") {
    return CODEX_EDITING_TOOLS;
  }
  if (agent === "hermes") {
    return HERMES_EDITING_TOOLS;
  }
  if (agent === "cursor") {
    return CURSOR_EDITING_TOOLS;
  }
  return EDITING_TOOLS;
}

const here = dirname(fileURLToPath(import.meta.url));

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

interface PostToolUseEnvelope {
  session_id?: string;
  hook_event_name?: string;
  tool_name?: string;
  tool_input?: unknown;
  tool_use_id?: string;
  extra?: {
    tool_call_id?: unknown;
    session_key?: unknown;
  };
  cwd?: string;
}

export type PostToolUseHookOutput = {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "PostToolUse";
    additionalContext?: string;
  };
};

type CursorPostToolOutput = { additional_context?: string };

async function emit(output: PostToolUseHookOutput | CursorPostToolOutput = {}): Promise<boolean> {
  return await new Promise<boolean>((resolve) => {
    try {
      process.stdout.write(`${JSON.stringify(output)}\n`, (error) => resolve(!error));
    } catch {
      resolve(false);
    }
  });
}

async function emitWithAcknowledgment(
  output: PostToolUseHookOutput | CursorPostToolOutput,
  acknowledge?: (handedOff: boolean) => Promise<void>,
): Promise<void> {
  const handedOff = await emit(output);
  await acknowledge?.(handedOff);
}

async function emitCursorContext(envelope: PostToolUseEnvelope): Promise<void> {
  if (
    typeof envelope.session_id !== "string" ||
    envelope.session_id.length === 0 ||
    typeof envelope.cwd !== "string" ||
    envelope.cwd.length === 0
  ) {
    await emit();
    return;
  }
  try {
    const context = await prepareCodexContext({
      cwd: envelope.cwd,
      sessionId: envelope.session_id,
      includeDigest: true,
      namespace: "cursor",
    });
    await emitWithAcknowledgment(
      context.context ? { additional_context: context.context } : {},
      context.acknowledge,
    );
  } catch {
    await emit();
  }
}

async function finish(agent: Agent, envelope?: PostToolUseEnvelope): Promise<void> {
  if (agent === "cursor" && envelope) await emitCursorContext(envelope);
  else await emit();
}

function debug(msg: string): void {
  if (process.env.PRIM_HOOK_VERBOSE === "1") {
    process.stderr.write(`[prim-post-tool-use] ${msg}\n`);
  }
}

async function main(): Promise<void> {
  const agent = parseAgent(process.argv);
  let raw: string;
  try {
    raw = await readHookStdin(STDIN_TIMEOUT_MS);
  } catch {
    await emit();
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    const incoming = JSON.parse(raw) as Record<string, unknown>;
    if (agent !== "cursor" && shouldSuppressImportedCursorHandler(incoming, "prim-post-tool-use")) {
      await emit();
      return;
    }
    parsed = normalizeEnvelope(incoming, agent);
  } catch {
    await emit();
    return;
  }
  let envelope = parsed as PostToolUseEnvelope;
  const isToolResult =
    envelope.hook_event_name === "PostToolUse" ||
    ((agent === "claude_code" || agent === "cursor") &&
      envelope.hook_event_name === "PostToolUseFailure");
  const isHermesDenial =
    agent === "hermes" &&
    envelope.hook_event_name === "post_approval_response" &&
    toolOutcomeFor(parsed, agent) === "prevented";
  if (!isToolResult && !isHermesDenial) {
    await finish(agent, envelope);
    return;
  }
  const invocationId = postToolInvocationId(parsed, agent);
  if (isHermesDenial && !invocationId) {
    await finish(agent, envelope);
    return;
  }
  const toolName = typeof envelope.tool_name === "string" ? envelope.tool_name : "";
  if (!isHermesDenial && !editingToolsFor(agent).has(toolName)) {
    await finish(agent, envelope);
    return;
  }
  if (
    isHermesDenial &&
    (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) &&
    typeof envelope.extra?.session_key === "string" &&
    envelope.extra.session_key.length > 0
  ) {
    parsed = { ...parsed, session_id: envelope.extra.session_key };
    envelope = parsed as PostToolUseEnvelope;
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    await finish(agent, envelope);
    return;
  }
  // Derive identity and repository context from the original cwd. `toMove`
  // scrubs user identity from persisted environment paths.
  const cwd = (parsed.cwd as string | undefined) ?? process.cwd();
  // Opt-in gate: ingest only in repos where prim is activated (prim.active).
  if (!isRepoActiveForCapture(cwd)) {
    await finish(agent, envelope);
    return;
  }
  const resolvedRepository = resolveRepositoryContext(cwd);
  if (!resolvedRepository) {
    await finish(agent, envelope);
    return;
  }
  const repository = { ...resolvedRepository, repoSyncId: repoSyncId(cwd) };

  const enrichment = enrichHookPayloadWithFileRefs({
    parsed,
    agent,
    cwd,
    repository,
  });
  const { resolution } = enrichment;
  // A Hermes approval denial carries no edited file or shell command, so it has
  // no file-refs and no shell mutation. Exempt it from the enrichment gate that
  // drops non-mutating tool results — otherwise the prevented-outcome move it
  // exists to produce would never be emitted. The gate still applies to every
  // real tool-result path.
  if (!isHermesDenial) {
    if (resolution.shellMutation === "none") {
      await finish(agent, envelope);
      return;
    }
    if (resolution.shellMutation === undefined && resolution.fileRefs.length === 0) {
      await finish(agent, envelope);
      return;
    }
  }
  const pathsComplete =
    !resolution.targetsIncomplete &&
    !resolution.targetsTruncated &&
    resolution.rejected.length === 0 &&
    resolution.shellMutation !== "unresolved";
  const hasPathEvidence =
    resolution.fileRefs.length > 0 ||
    resolution.rejected.length > 0 ||
    resolution.targetsIncomplete ||
    resolution.targetsTruncated ||
    resolution.shellMutation === "unresolved";
  if (
    agent === "cursor" &&
    (resolution.rejected.length > 0 ||
      resolution.targetsIncomplete ||
      resolution.targetsTruncated ||
      resolution.shellMutation === "unresolved")
  ) {
    await finish(agent, envelope);
    return;
  }
  if (
    !cachedCollectScopeAdmits(cwd, {
      repository: resolvedRepository.repoFullName,
      branch: currentBranch(cwd),
      agent,
      ...(isHermesDenial || !hasPathEvidence ? {} : { paths: resolution.fileRefs, pathsComplete }),
    })
  ) {
    await finish(agent, envelope);
    return;
  }
  const enriched = enrichment.parsed;
  // Stamp the same worktree provenance as passive prim-hook. The classifier
  // may collapse these duplicate PostToolUse observations and keep either one.
  const identity = getOrCreateWorkspaceId(cwd);
  const workspaceId = identity.status === "ready" ? identity.workspaceId : undefined;
  // Reuse the invocationId declared above (the Hermes-denial guard needs it
  // early); toMove derives toolOutcome from the enriched envelope internally.
  const base = toMove(enriched, resolveCliVersion(), agent, workspaceId, repository, invocationId);
  const scrubbed = await scrubFromCwd(enriched, cwd);
  const move: Move = {
    ...base,
    payload: preserveHookFileMetadata(scrubbed, resolution),
  };
  // Write-ahead before the synchronous fast path. The direct POST and every
  // later replay carry this exact moveId, so a timeout/crash cannot create an
  // ingestion gap and a successful direct delivery deduplicates safely when
  // the daemon eventually drains the journal.
  const { orgId } = resolveOrg({ sessionId: move.sessionId, cwd });
  let verdictFooter = false;
  try {
    const result = await deliverPostToolMove(move, orgId);
    debug(`durably ingested ${move.moveId} (${toolName})`);
    // Render the verdict footer when the ingest response carries the
    // bypass-correlation context (the user just completed a reconcile within
    // the server-side footer window). It rides STDERR as a human signal.
    if (isVerdictFooterContext(result.verdictFooter)) {
      verdictFooter = true;
      process.stderr.write(`${renderVerdictFooter(result.verdictFooter)}\n`);
    }
  } catch (err) {
    debug(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (agent === "codex" && verdictFooter) {
    try {
      const context = await prepareCodexContext({
        cwd,
        sessionId: envelope.session_id,
        includeDigest: false,
      });
      await emitWithAcknowledgment(appendCodexContext({}, context.context), context.acknowledge);
      return;
    } catch {
      // The existing STDERR verdict remains the authoritative user signal.
    }
  }
  await finish(agent, envelope);
}

main().catch(async () => {
  await emit();
});
