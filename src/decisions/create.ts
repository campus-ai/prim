/**
 * `prim decisions create` — record a decision directly: the deliberate
 * path around automatic capture (session hooks → classifier).
 *
 * POSTs to /api/cli/decisions/create and echoes the new decision's
 * identity so the caller can immediately `show` / `cascade` / `confirm`
 * it in the same turn. Org and author are derived server-side from the
 * bearer token, never sent in the body. Attribution separately records
 * whether the exact choice originated with the user or the agent. Empty
 * and undefined optional fields are pruned so the server applies its
 * defaults (kind change, confidence and reversibility high).
 *
 * AX contract: STDOUT is machine-readable JSON (the created identity),
 * STDERR is the verdict-first human line. Exit 0 on success; the command
 * maps a 4xx domain rejection (bad enum, org-unbound) to exit 2 and lets
 * transport / 5xx failures surface as exit 1.
 */

import { type CliClient, getClient } from "../client.js";
import { renderIdentifier } from "./recent.js";

export interface CreateRequest {
  intent: string;
  attribution: "user" | "agent";
  kind?: "change" | "exploration" | "task_execution" | "unclear";
  rationale?: string;
  area?: string;
  decided?: string[];
  alternatives?: string[];
  confidence?: "high" | "medium" | "low";
  reversibility?: "high" | "low";
  /** Repo-relative paths this decision governs (gates edits to them). */
  files?: string[];
  /** Opaque repository identity paired with files. */
  repoKey?: string;
}

/** The created decision's identity, as returned by the server (201). */
export interface CreateOutcome {
  decisionId: string;
  shortId?: string;
  createdAt: number;
}

export const CREATE_TIMEOUT_MS = 10_000;

export interface CreateDeps {
  getClient: () => CliClient;
}

const defaultDeps: CreateDeps = { getClient };

/**
 * Prune undefined and empty fields so the wire body carries only what the
 * author actually set — the server fills the rest with its defaults.
 * Mirrors the thin-body / server-owned-policy convention of the other
 * write surfaces.
 */
function toRequestBody(request: CreateRequest): Record<string, unknown> {
  const candidate: Record<string, unknown> = {
    intent: request.intent,
    attribution: request.attribution,
    kind: request.kind,
    rationale: request.rationale,
    area: request.area,
    decided: request.decided,
    alternatives: request.alternatives,
    confidence: request.confidence,
    reversibility: request.reversibility,
    files: request.files,
    repoKey: request.repoKey,
  };
  const body: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    const isEmpty = value === undefined || (Array.isArray(value) && value.length === 0);
    if (!isEmpty) {
      body[key] = value;
    }
  }
  return body;
}

export async function fetchCreate(
  request: CreateRequest,
  deps: CreateDeps = defaultDeps,
): Promise<CreateOutcome> {
  const client = deps.getClient();
  return (await client.post("/api/cli/decisions/create", toRequestBody(request), {
    signal: AbortSignal.timeout(CREATE_TIMEOUT_MS),
  })) as CreateOutcome;
}

export function formatCreateHuman(outcome: CreateOutcome, codeScoped = true): string {
  const id = renderIdentifier({ shortId: outcome.shortId, id: outcome.decisionId });
  return codeScoped
    ? `[prim] created ${id}.`
    : `[prim] created ${id} · not code-scoped; edits cannot enforce it until files are attached.`;
}

export function formatCreateJson(outcome: CreateOutcome): string {
  return JSON.stringify(outcome, null, 2);
}
