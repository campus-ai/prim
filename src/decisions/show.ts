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
 * string[], optional `contexts[].name`, and `dependsOn` / `dependents` as lean
 * DecisionNode[]; never the raw fileRefs / contextRefs / edge-doc
 * columns the projection deliberately drops.
 */

import { type CliClient, getClient } from "../client.js";
import { daemonOrDirectGet } from "../daemon/proxy.js";
import { color, colorForArea } from "../lib/ansi.js";
import { terminalSafeLine } from "../lib/terminal-safe.js";
import { renderIdentifier } from "./recent.js";

const NOT_FOUND_RE = /not found/i;

function colorStatus(status: "active" | "superseded" | "under_review"): string {
  const safeStatus = terminalSafeLine(status);
  if (status === "under_review") {
    return color(safeStatus, "orange");
  }
  if (status === "active") {
    return color(safeStatus, "green");
  }
  return color(safeStatus, "gray");
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

export interface DecisionLocationScope {
  repository: boolean;
  directories: string[];
  globs: string[];
  branches: string[];
}

export interface DecisionTimeScope {
  effectiveFrom?: number;
  effectiveUntil?: number;
}

export type DecisionUserScopeReadMember =
  | { kind: "user"; userId: string; displayName: string }
  | { kind: "role"; role: "owner" | "admin" | "member" }
  | { kind: "agent"; agent: "claude_code" | "codex" | "hermes" }
  | {
      kind: "credential";
      credential: "workos_jwt" | "workos_api_key" | "service_token";
    };

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
  // The server omits this join when a Decision has no attached context rows.
  contexts?: { id: string; name: string }[];
  flags: DecisionFlagSummary[];
  dependsOn: DecisionNode[];
  dependents: DecisionNode[];
  scope?: {
    location: DecisionLocationScope;
    time: DecisionTimeScope;
    /** Optional only for compatibility with server versions before audience reads. */
    users?: DecisionUserScopeReadMember[];
  };
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
    return await daemonOrDirectGet<DecisionShowResult>(
      "decisions_show",
      `/api/cli/decisions/show?${params.toString()}`,
      client,
      SHOW_TIMEOUT_MS,
    );
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
  const type = terminalSafeLine(flag.type);
  const detail = flag.reason ? ` — ${terminalSafeLine(flag.reason)}` : "";
  if (flag.acknowledgedAt !== undefined) {
    return `acknowledged ${type}${detail}`;
  }
  if (flag.type === "confirmation_request") {
    return `pending confirmation request${detail}`;
  }
  if (GATED_FLAG_KINDS.has(flag.type)) {
    const verdict = terminalSafeLine(flag.gateVerdict ?? "unknown");
    return `pending ${type} (verdict: ${verdict})${detail}`;
  }
  return `pending ${type}${detail}`;
}

function describeNode(node: DecisionNode): string {
  const id = renderIdentifier({ shortId: node.shortId, id: node.id });
  const safeArea = terminalSafeLine(node.area ?? "");
  const area = safeArea ? ` • ${safeArea}` : "";
  return `${id}${area}  ${terminalSafeLine(node.intent)}  (${terminalSafeLine(node.authorName)})`;
}

function pushFiles(lines: string[], files: string[]): void {
  if (files.length === 0) {
    return;
  }
  lines.push(`  files (${String(files.length)}):`);
  for (const file of files) {
    lines.push(`    - ${terminalSafeLine(file)}`);
  }
}

function pushContexts(lines: string[], contexts: { id: string; name: string }[]): void {
  if (contexts.length === 0) {
    return;
  }
  lines.push(`  contexts (${String(contexts.length)}):`);
  for (const ctx of contexts) {
    lines.push(`    - ${terminalSafeLine(ctx.name)}`);
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

function effectiveTimestamp(value: number): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
}

function describeEffectiveWindow(scope: DecisionTimeScope): string | undefined {
  const bounds = [
    ...(scope.effectiveFrom === undefined
      ? []
      : [`from ${effectiveTimestamp(scope.effectiveFrom)}`]),
    ...(scope.effectiveUntil === undefined
      ? []
      : [`until ${effectiveTimestamp(scope.effectiveUntil)}`]),
  ];
  return bounds.length === 0 ? undefined : bounds.join("; ");
}

function describeAudienceMember(member: DecisionUserScopeReadMember): string {
  switch (member.kind) {
    case "user":
      return terminalSafeLine(member.displayName || member.userId);
    case "role":
      return `${terminalSafeLine(member.role)}s`;
    case "agent":
      return (
        {
          claude_code: "Claude Code agent",
          codex: "Codex agent",
          hermes: "Hermes agent",
        }[member.agent] ?? terminalSafeLine(member.agent)
      );
    case "credential":
      return (
        {
          workos_jwt: "WorkOS JWT credential",
          workos_api_key: "WorkOS API key credential",
          service_token: "Service token credential",
        }[member.credential] ?? terminalSafeLine(member.credential)
      );
  }
}

function describeAudience(users: DecisionUserScopeReadMember[] | undefined): string {
  return users === undefined || users.length === 0
    ? "everyone"
    : users.map(describeAudienceMember).join(", ");
}

export function formatShowHuman(result: DecisionShowResult): string {
  const d = result.decision;
  const id = color(renderIdentifier({ shortId: d.shortId, id: d.id }), "orange");
  const confidence = d.confidence ?? "(unset)";
  const lines = [
    `[prim] ${id} — ${terminalSafeLine(d.intent)}`,
    `  status: ${colorStatus(d.status)}${d.confirmed ? " (confirmed)" : ""}  ·  confidence: ${terminalSafeLine(confidence)}  ·  reversibility: ${terminalSafeLine(d.reversibility ?? "(unset)")}`,
  ];
  if (d.supersededBy) {
    lines.push(`  superseded by: ${terminalSafeLine(d.supersededBy)}`);
  }
  if (d.area) {
    const area = terminalSafeLine(d.area);
    lines.push(`  area: ${color(area, colorForArea(area))}`);
  }
  const effectiveWindow = result.scope && describeEffectiveWindow(result.scope.time);
  if (effectiveWindow) {
    lines.push(`  effective: ${effectiveWindow}`);
  }
  if (result.scope) {
    lines.push(`  audience: ${describeAudience(result.scope.users)}`);
  }
  if (typeof d.fanOut === "number") {
    lines.push(`  fan-out: ${String(d.fanOut)}`);
  }
  if (d.respondedAt !== undefined) {
    lines.push(`  responded at: ${new Date(d.respondedAt).toISOString()}`);
  }
  if (d.rationale) {
    lines.push(`  rationale: ${terminalSafeLine(d.rationale)}`);
  }
  if (d.decided && d.decided.length > 0) {
    lines.push(`  decided (${String(d.decided.length)}):`);
    for (const point of d.decided) {
      lines.push(`    - ${terminalSafeLine(point)}`);
    }
  }
  if (d.alternatives.length > 0) {
    lines.push(`  alternatives: ${d.alternatives.map(terminalSafeLine).join(" | ")}`);
  }
  pushFiles(lines, result.files);
  pushContexts(lines, result.contexts ?? []);
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
