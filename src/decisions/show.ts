/**
 * `prim decisions show <idOrShortId>` — full detail of one decision.
 *
 * STDOUT is the raw JSON response — decision row plus flags + fileRefs
 * + contextRefs + dependency edges in both directions. STDERR is a
 * verdict-first human block with the intent, author, area, rationale,
 * referenced files, dependents, and current status. AX contract: exit
 * 0 on success, exit ≠ 0 only on auth / network / not-found.
 */

import { type CliClient, getClient } from "../client.js";
import { renderIdentifier } from "./recent.js";

export interface DecisionDoc {
  _id: string;
  sessionId: string;
  userId: string;
  intent: string;
  intentKind: string;
  rationale?: string;
  alternatives: string[];
  confidence: "high" | "medium" | "low";
  reversibility?: "high" | "low";
  status?: "active" | "superseded" | "under_review";
  confirmed?: boolean;
  area?: string;
  producerKind?: string;
  shortId?: string;
  fanOut?: number;
  classifiedAt: number;
  classifierVersion: string;
  model: string;
}

export interface FlagDoc {
  _id: string;
  decisionId: string;
  triggeredByType?: string;
  triggeredByFile?: string;
  triggeredByContextId?: string;
  gateVerdict?: "invalidated" | "uncertain" | "unavailable";
  flaggedAt: number;
  acknowledgedAt?: number;
}

export interface FileRefDoc {
  _id: string;
  decisionId: string;
  file: string;
}

export interface ContextRefDoc {
  _id: string;
  decisionId: string;
  contextId: string;
  accessKind: "read" | "edit";
}

export interface DependencyEdgeDoc {
  _id: string;
  parentId: string;
  childId: string;
}

export interface DecisionShowResult {
  decision: DecisionDoc;
  flags: FlagDoc[];
  fileRefs: FileRefDoc[];
  contextRefs: ContextRefDoc[];
  depsOn: DependencyEdgeDoc[];
  dependents: DependencyEdgeDoc[];
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
    if (err instanceof Error && /not found/i.test(err.message)) {
      throw new DecisionNotFoundError(idOrShortId);
    }
    throw err;
  }
}

const PENDING_FLAG_KINDS = new Set(["file_edit", "supersession", "context_edit"]);

function describeFlag(flag: FlagDoc): string {
  if (flag.acknowledgedAt !== undefined) {
    return `acknowledged ${flag.triggeredByType ?? "flag"}`;
  }
  if (flag.triggeredByType === "confirmation_request") {
    return "pending confirmation request";
  }
  if (flag.triggeredByType && PENDING_FLAG_KINDS.has(flag.triggeredByType)) {
    const verdict = flag.gateVerdict ?? "unknown";
    return `pending ${flag.triggeredByType} (verdict: ${verdict})`;
  }
  return `pending ${flag.triggeredByType ?? "flag"}`;
}

export function formatShowHuman(result: DecisionShowResult): string {
  const d = result.decision;
  const id = renderIdentifier({ shortId: d.shortId, id: d._id });
  const status = d.status ?? "active";
  const lines = [
    `[prim] ${id} — ${d.intent}`,
    `  status: ${status}${d.confirmed ? " (confirmed)" : ""}  ·  confidence: ${d.confidence}  ·  reversibility: ${d.reversibility ?? "(unset)"}`,
  ];
  if (d.area) {
    lines.push(`  area: ${d.area}`);
  }
  if (d.rationale) {
    lines.push(`  rationale: ${d.rationale}`);
  }
  if (d.alternatives.length > 0) {
    lines.push(`  alternatives: ${d.alternatives.join(" | ")}`);
  }
  if (result.fileRefs.length > 0) {
    lines.push(`  files (${String(result.fileRefs.length)}):`);
    for (const r of result.fileRefs) {
      lines.push(`    - ${r.file}`);
    }
  }
  if (result.contextRefs.length > 0) {
    lines.push(`  contexts (${String(result.contextRefs.length)}):`);
    for (const r of result.contextRefs) {
      lines.push(`    - ${r.contextId}  (${r.accessKind})`);
    }
  }
  if (result.dependents.length > 0) {
    lines.push(`  dependents (${String(result.dependents.length)}):`);
    for (const e of result.dependents) {
      lines.push(`    → ${e.childId}`);
    }
  }
  if (result.depsOn.length > 0) {
    lines.push(`  depends on (${String(result.depsOn.length)}):`);
    for (const e of result.depsOn) {
      lines.push(`    ← ${e.parentId}`);
    }
  }
  if (result.flags.length > 0) {
    lines.push(`  flags (${String(result.flags.length)}):`);
    for (const f of result.flags) {
      lines.push(`    · ${describeFlag(f)}`);
    }
  }
  return lines.join("\n");
}

export function formatShowJson(result: DecisionShowResult): string {
  return JSON.stringify(result, null, 2);
}
