#!/usr/bin/env node
/**
 * prim PostToolUse hook for Claude Code and Codex.
 *
 * Captures edit-tool completions — Claude Code Edit/Write/MultiEdit or Codex
 * apply_patch (selected by `--agent`) — as `moves` rows by POSTing them to the
 * server's ingest endpoint, where the extractor / classifier /
 * linker pipeline turns them into decisions. Unlike the passive capture hook
 * (which journals locally and drains later), this hook ingests synchronously
 * so the server can return an immediate verdict footer for a reconciled edit.
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
import { getClient } from "../client.js";
import { isRepoActiveForCapture } from "../lib/activation.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { gitToplevel } from "../lib/git.js";
import type { Move } from "../protocol/move.js";
import { type Agent, parseAgent } from "./agent.js";
import { normalizeEnvelope } from "./normalize.js";
import { toMove } from "./prim-hook-core.js";
import { scrubFromCwd } from "./redact.js";
import { isVerdictFooterContext, renderVerdictFooter } from "./verdict-footer.js";

const STDIN_TIMEOUT_MS = 1_000;
const INGEST_TIMEOUT_MS = 4_000;
const EDITING_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);
// Codex routes file edits through apply_patch (its single edit tool).
const CODEX_EDITING_TOOLS = new Set(["apply_patch"]);
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
  cwd?: string;
}

interface IngestResponse {
  accepted: number;
  verdictFooter?: unknown;
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

async function ingestMove(move: Move): Promise<IngestResponse> {
  const client = getClient();
  return (await client.post(
    "/api/cli/moves/ingest",
    { batch: [move] },
    { signal: AbortSignal.timeout(INGEST_TIMEOUT_MS) },
  )) as IngestResponse;
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
  const base = toMove(parsed, resolveCliVersion(), agent, gitToplevel(cwd) ?? undefined);
  const move: Move = { ...base, payload: scrubFromCwd(parsed, cwd) };
  try {
    const result = await ingestMove(move);
    debug(`ingested ${move.moveId} (${toolName})`);
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
