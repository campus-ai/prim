/**
 * `prim decisions show <idOrShortId>` — full detail of one decision.
 *
 * STDOUT is the machine-readable JSON projection the server emits — the
 * lean decision row plus files, contexts, flags, and the dependency
 * neighborhood (dependsOn / dependents) in both directions. STDERR is a
 * verdict-first human block with the intent, author, area, rationale,
 * decided points, referenced files, contexts, edges, and current
 * status. AX contract: exit 0 on success, exit ≠ 0 only on auth /
 * network / not-found (the command maps DecisionNotFoundError to exit
 * 4).
 *
 * The wire shape mirrors `DecisionDetail` in
 * convex/decisions/internal.ts verbatim — a lean projection, NOT raw
 * Convex documents. Read `decision.id` (not `_id`), `files` as a flat
 * string[], `contexts[].name`, and `dependsOn` / `dependents` as lean
 * DecisionNode[]; never the raw fileRefs / contextRefs / edge-doc
 * columns the projection deliberately drops.
 */

import { type CliClient, getClient } from "../client.js";
import { color, colorForArea } from "../lib/ansi.js";
import { renderIdentifier } from "./recent.js";

const NOT_FOUND_RE = /not found/i;

function colorStatus(status: "active" | "superseded" | "under_review"): string {
  if (status === "under_review") {
    return color(status, "orange");
  }
  if (status === "active") {
    return color(status, "green");
  }
  return color(status, "gray");
}

/** Lean projection of a related decision (dependency edge endpoint). */
export interface DecisionNode {
  id: string;
  shortId?: string;
  intent: string;
  area?: string;
  authorName: string;
  classifiedAt: number;
  status: "active" | "superseded" | "under_review";
}

export interface DecisionFlagSummary {
  type: string;
  file?: string;
  flaggedAt: number;
  acknowledgedAt?: number;
  gateVerdict?: string;
  reason?: string;
}

export interface DecisionShowResult {
  decision: {
    id: string;
    shortId?: string;
    intent: string;
    intentKind?: string;
    rationale?: string;
    decided?: string[];
    alternatives: string[];
    area?: string;
    producerKind?: string;
    status: "active" | "superseded" | "under_review";
    supersededBy?: string | null;
    confidence?: "high" | "medium" | "low";
    reversibility?: "high" | "low";
    confirmed?: boolean;
    respondedAt?: number;
    fanOut?: number;
    classifiedAt: number;
    authorName: string;
  };
  files: string[];
  contexts: { id: string; name: string }[];
  flags: DecisionFlagSummary[];
  dependsOn: DecisionNode[];
  dependents: DecisionNode[];
  truncated: boolean;
}

export const SHOW_TIMEOUT_MS = 10_000;

export interface ShowDeps {
  getClient: () => CliClient;
}

const defaultDeps: ShowDeps = { getClient };

export class DecisionNotFoundError extends Error {
  constructor(idOrShortId: string) {
    super(`Decision not found: ${idOrShortId}`);
    this.name = "DecisionNotFoundError";
  }
}

export async function fetchShow(
  idOrShortId: string,
  deps: ShowDeps = defaultDeps,
): Promise<DecisionShowResult> {
  const params = new URLSearchParams({ id: idOrShortId });
  const client = deps.getClient();
  try {
    return (await client.get(`/api/cli/decisions/show?${params.toString()}`, {
      signal: AbortSignal.timeout(SHOW_TIMEOUT_MS),
    })) as DecisionShowResult;
  } catch (err) {
    if (err instanceof Error && NOT_FOUND_RE.test(err.message)) {
      throw new DecisionNotFoundError(idOrShortId);
    }
    throw err;
  }
}

// Flag kinds that carry a gate verdict worth surfacing when pending.
const GATED_FLAG_KINDS = new Set(["file_edit", "supersession", "context_edit"]);

function describeFlag(flag: DecisionFlagSummary): string {
  const detail = flag.reason ? ` — ${flag.reason}` : "";
  if (flag.acknowledgedAt !== undefined) {
    return `acknowledged ${flag.type}${detail}`;
  }
  if (flag.type === "confirmation_request") {
    return `pending confirmation request${detail}`;
  }
  if (GATED_FLAG_KINDS.has(flag.type)) {
    const verdict = flag.gateVerdict ?? "unknown";
    return `pending ${flag.type} (verdict: ${verdict})${detail}`;
  }
  return `pending ${flag.type}${detail}`;
}

function describeNode(node: DecisionNode): string {
  const id = renderIdentifier({ shortId: node.shortId, id: node.id });
  const area = node.area ? ` • ${node.area}` : "";
  return `${id}${area}  ${node.intent}  (${node.authorName})`;
}

function pushFiles(lines: string[], files: string[]): void {
  if (files.length === 0) {
    return;
  }
  lines.push(`  files (${String(files.length)}):`);
  for (const file of files) {
    lines.push(`    - ${file}`);
  }
}

function pushContexts(lines: string[], contexts: { id: string; name: string }[]): void {
  if (contexts.length === 0) {
    return;
  }
  lines.push(`  contexts (${String(contexts.length)}):`);
  for (const ctx of contexts) {
    lines.push(`    - ${ctx.name}`);
  }
}

function pushEdges(lines: string[], label: string, arrow: string, nodes: DecisionNode[]): void {
  if (nodes.length === 0) {
    return;
  }
  lines.push(`  ${label} (${String(nodes.length)}):`);
  for (const node of nodes) {
    lines.push(`    ${arrow} ${describeNode(node)}`);
  }
}

export function formatShowHuman(result: DecisionShowResult): string {
  const d = result.decision;
  const id = color(renderIdentifier({ shortId: d.shortId, id: d.id }), "orange");
  const confidence = d.confidence ?? "(unset)";
  const lines = [
    `[prim] ${id} — ${d.intent}`,
    `  status: ${colorStatus(d.status)}${d.confirmed ? " (confirmed)" : ""}  ·  confidence: ${confidence}  ·  reversibility: ${d.reversibility ?? "(unset)"}`,
  ];
  if (d.supersededBy) {
    lines.push(`  superseded by: ${d.supersededBy}`);
  }
  if (d.area) {
    lines.push(`  area: ${color(d.area, colorForArea(d.area))}`);
  }
  if (typeof d.fanOut === "number") {
    lines.push(`  fan-out: ${String(d.fanOut)}`);
  }
  if (d.respondedAt !== undefined) {
    lines.push(`  responded at: ${new Date(d.respondedAt).toISOString()}`);
  }
  if (d.rationale) {
    lines.push(`  rationale: ${d.rationale}`);
  }
  if (d.decided && d.decided.length > 0) {
    lines.push(`  decided (${String(d.decided.length)}):`);
    for (const point of d.decided) {
      lines.push(`    - ${point}`);
    }
  }
  if (d.alternatives.length > 0) {
    lines.push(`  alternatives: ${d.alternatives.join(" | ")}`);
  }
  pushFiles(lines, result.files);
  pushContexts(lines, result.contexts);
  pushEdges(lines, "dependents", "→", result.dependents);
  pushEdges(lines, "depends on", "←", result.dependsOn);
  if (result.flags.length > 0) {
    lines.push(`  flags (${String(result.flags.length)}):`);
    for (const flag of result.flags) {
      lines.push(`    · ${describeFlag(flag)}`);
    }
  }
  if (result.truncated) {
    lines.push("  (partial — some related rows were truncated by a join cap)");
  }
  return lines.join("\n");
}

export function formatShowJson(result: DecisionShowResult): string {
  return JSON.stringify(result, null, 2);
}
