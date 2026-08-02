#!/usr/bin/env node
/**
 * prim PostToolUse hook for Claude Code and Codex.
 *
 * Captures edit-tool completions — Claude Code Edit/Write/MultiEdit/NotebookEdit or Codex
 * apply_patch (selected by `--agent`) — as `moves` rows by POSTing them to the
 * server's ingest endpoint, where the extractor / classifier /
 * linker pipeline turns them into decisions. It writes the Move to the same
 * durable journal first, then attempts synchronous ingest so the server can
 * return an immediate verdict footer without making recovery depend on HTTP.
 *
 * The move carries the canonical envelope — including env.cwd — so the server
 * can relativize the edited file into the repository-relative key its
 * conflict / cascade joins are built on; without it the server can resolve no
 * edited file and the verdict footer is permanently null. The payload is
 * PII / secret scrubbed before it leaves the machine, matching the capture
 * path.
 *
 * Fail-soft: every failure path exits 0 with empty JSON on stdout.
 *
 * AX contract: STDOUT is `{}\n`. STDERR is silent unless PRIM_HOOK_VERBOSE=1,
 * except for the verdict footer (a deliberate human signal on STDERR).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOrg } from "../binding.js";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { resolveRepositoryContext } from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Move } from "../protocol/move.js";
import { type Agent, parseAgent } from "./agent.js";
import { enrichHookPayloadWithFileRefs, preserveHookFileMetadata } from "./file-refs.js";
import { normalizeEnvelope } from "./normalize.js";
import { deliverPostToolMove } from "./post-tool-delivery.js";
import { postToolInvocationId, toMove } from "./prim-hook-core.js";
import { scrubFromCwd } from "./redact.js";
import { isVerdictFooterContext, renderVerdictFooter } from "./verdict-footer.js";

const STDIN_TIMEOUT_MS = 1_000;
const EDITING_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit", "Bash"]);
// Codex exposes both apply_patch and shell commands through tool hooks.
const CODEX_EDITING_TOOLS = new Set(["apply_patch", "Bash"]);
// Hermes routes file edits through write_file and patch.
const HERMES_EDITING_TOOLS = new Set(["write_file", "patch"]);

function editingToolsFor(agent: Agent): Set<string> {
  if (agent === "codex") {
    return CODEX_EDITING_TOOLS;
  }
  if (agent === "hermes") {
    return HERMES_EDITING_TOOLS;
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

function emit(): void {
  process.stdout.write("{}\n");
}

function debug(msg: string): void {
  if (process.env.PRIM_HOOK_VERBOSE === "1") {
    process.stderr.write(`[prim-post-tool-use] ${msg}\n`);
  }
}

async function main(): Promise<void> {
  warmBinCache();
  const agent = parseAgent(process.argv);
  let raw: string;
  try {
    raw = await readStdin();
  } catch {
    emit();
    return;
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = normalizeEnvelope(JSON.parse(raw) as Record<string, unknown>, agent);
  } catch {
    emit();
    return;
  }
  const envelope = parsed as PostToolUseEnvelope;
  if (envelope.hook_event_name !== "PostToolUse") {
    emit();
    return;
  }
  const toolName = typeof envelope.tool_name === "string" ? envelope.tool_name : "";
  const editingTools = editingToolsFor(agent);
  if (!editingTools.has(toolName)) {
    emit();
    return;
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    emit();
    return;
  }
  // Derive identity + env.cwd from the ORIGINAL envelope, then scrub only the
  // payload that persists — exactly as the capture hook does.
  const cwd = (parsed.cwd as string | undefined) ?? process.cwd();
  // Opt-in gate: ingest only in repos where prim is activated (prim.active).
  if (!isRepoActiveForCapture(cwd)) {
    emit();
    return;
  }
  const resolvedRepository = resolveRepositoryContext(cwd);
  if (!resolvedRepository) {
    emit();
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
  if (resolution.shellMutation === "none") {
    emit();
    return;
  }
  if (resolution.shellMutation === undefined && resolution.fileRefs.length === 0) {
    emit();
    return;
  }
  const enriched = enrichment.parsed;
  // Stamp the same worktree provenance as passive prim-hook. The classifier
  // may collapse these duplicate PostToolUse observations and keep either one.
  const identity = getOrCreateWorkspaceId(cwd);
  const workspaceId = identity.status === "ready" ? identity.workspaceId : undefined;
  const invocationId = postToolInvocationId(enriched, agent);
  const base = toMove(enriched, resolveCliVersion(), agent, workspaceId, repository, invocationId);
  const scrubbed = scrubFromCwd(enriched, cwd);
  const move: Move = {
    ...base,
    payload: preserveHookFileMetadata(scrubbed, resolution),
  };
  // Write-ahead before the synchronous fast path. The direct POST and every
  // later replay carry this exact moveId, so a timeout/crash cannot create an
  // ingestion gap and a successful direct delivery deduplicates safely when
  // the daemon eventually drains the journal.
  const { orgId } = resolveOrg({ sessionId: move.sessionId, cwd: move.env.cwd });
  try {
    const result = await deliverPostToolMove(move, orgId);
    debug(`durably ingested ${move.moveId} (${toolName})`);
    // Render the verdict footer when the ingest response carries the
    // bypass-correlation context (the user just completed a reconcile within
    // the server-side footer window). It rides STDERR as a human signal.
    if (isVerdictFooterContext(result.verdictFooter)) {
      process.stderr.write(`${renderVerdictFooter(result.verdictFooter)}\n`);
    }
  } catch (err) {
    debug(`ingest failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  emit();
}

main().catch(() => {
  emit();
});
