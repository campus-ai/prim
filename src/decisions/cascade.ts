/**
 * `prim decisions cascade <idOrShortId>` — ASCII subgraph for the
 * decision's local cascade:
 *
 *   what this would break · N decisions · enforcing
 *
 *   knowledge
 *     [auth.spec]  [mobile-session.spec *]  [RFC-014]
 *                            |
 *                       refs (just edited)
 *                            ▼
 *   • Refresh tokens —┐
 *   • HTTP cookies  —┼─→ • 7-day refresh ──→  [ 6 affected:
 *   • Mobile session                            Logout flow, ... ]
 *
 *   trigger: ...
 *   impact:  N decisions need review
 *
 * STDOUT is the raw JSON response from the server. STDERR is the
 * rendered ASCII block. Renderer is hand-rolled in
 * `cascade-renderer.ts`.
 */

import { type CliClient, getClient } from "../client.js";

const NOT_FOUND_RE = /not found/i;

export interface CascadeNode {
  id: string;
  shortId: string | undefined;
  intent: string;
  area: string | undefined;
  authorName: string;
  classifiedAt: number;
  status: "active" | "superseded" | "under_review";
}

export interface CascadeUpstream {
  files: string[];
  contexts: { id: string; name: string }[];
}

export interface CascadeTrigger {
  type: "file_edit" | "supersession" | "context_edit" | "invalidation" | "confirmation_request";
  file: string | undefined;
  contextName: string | undefined;
  flaggedAt: number;
  // Rich trigger line — both fields ride the server projection directly:
  //   `authorName` is who fired the trigger (resolved from the triggering
  //   move's user; absent for impersonal kinds), and `reason` is the flag's
  //   free-text triage reason. The earlier `narrative` field was a fiction
  //   the server never emitted, so the rich line was permanently dead (F10).
  authorName: string | undefined;
  reason: string | undefined;
}

export interface CascadeResult {
  decision: CascadeNode;
  rationale: string | undefined;
  reversibility: "high" | "low" | undefined;
  fanOut: number;
  upstream: CascadeUpstream;
  downstream: CascadeNode[];
  trigger: CascadeTrigger | null;
  // Top-level clip flag: true when any projected ref/edge list (files,
  // contexts, flags, dependents) exceeded the server scan cap. A clipped
  // blast radius must never render as complete (F11).
  truncated: boolean;
}

export const CASCADE_TIMEOUT_MS = 10_000;

export interface CascadeDeps {
  getClient: () => CliClient;
}

const defaultDeps: CascadeDeps = { getClient };

export class CascadeNotFoundError extends Error {
  constructor(idOrShortId: string) {
    super(`Decision not found: ${idOrShortId}`);
    this.name = "CascadeNotFoundError";
  }
}

export async function fetchCascade(
  idOrShortId: string,
  deps: CascadeDeps = defaultDeps,
): Promise<CascadeResult> {
  const params = new URLSearchParams({ id: idOrShortId });
  const client = deps.getClient();
  try {
    return (await client.get(`/api/cli/decisions/cascade?${params.toString()}`, {
      signal: AbortSignal.timeout(CASCADE_TIMEOUT_MS),
    })) as CascadeResult;
  } catch (err) {
    if (err instanceof Error && NOT_FOUND_RE.test(err.message)) {
      throw new CascadeNotFoundError(idOrShortId);
    }
    throw err;
  }
}

export function formatCascadeJson(result: CascadeResult): string {
  return JSON.stringify(result, null, 2);
}
