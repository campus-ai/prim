/**
 * `prim decisions link <child> --on <parent>` and `... unlink <child> --on
 * <parent>` — the manual path to relate two existing decisions ("child depends
 * on parent") and to remove such a relation. The mechanical linker is otherwise
 * the only writer of dependency edges; this lets a user connect orphaned
 * decisions, or cut a linker file-overlap false positive.
 *
 * The server answers with a discriminated outcome on 200 (linked /
 * already_linked / unlinked / not_linked, each carrying the resolved endpoint
 * ids), and expresses the rejections as HTTP status: 404 unknown id, 409
 * ambiguous shortId, 422 self-loop or would-create-a-cycle. We fold those back
 * onto one union so a single formatter covers every case — 404 becomes a
 * {@link LinkNotFoundError} (the command maps it to exit 4); 409/422 resolve to
 * distinct verdict lines (exit 2). The human verdict ECHOES the dependency
 * direction in words for every applied/idempotent outcome, so a mistaken `--on`
 * is caught by reading, not by guessing (the rejection lines are self-describing).
 *
 * AX contract: STDOUT is machine-readable JSON (formatRelateJson); STDERR is the
 * verdict-first `[prim]` line (formatRelateHuman). Exit 0 on every resolved /
 * idempotent case; non-zero only on rejection (2) or not-found (4) or transport.
 */

import { type CliClient, getClient } from "../client.js";
import { renderIdentifier } from "./recent.js";

export const RELATE_TIMEOUT_MS = 10_000;

type RelateEndpoints = {
  childId: string;
  childShortId: string | undefined;
  parentId: string;
  parentShortId: string | undefined;
};

/**
 * Mirror of the server outcome, narrowed to what a CLI caller observes. The
 * resolved/idempotent variants arrive as the 200 body; `self_loop` /
 * `would_cycle` / `ambiguous` are reconstructed from the thrown HTTP error.
 * `not_found` is absent — it throws {@link LinkNotFoundError} for exit 4.
 */
export type RelateOutcome =
  | ({ outcome: "linked" | "already_linked" | "unlinked" | "not_linked" } & RelateEndpoints)
  | { outcome: "self_loop" }
  | { outcome: "would_cycle"; detail: string }
  | { outcome: "ambiguous"; which: "child" | "parent" };

export type RelateRequest = { child: string; parent: string };

export type RelateResult = { request: RelateRequest; outcome: RelateOutcome };

export type RelateDeps = { getClient: () => CliClient };

const defaultDeps: RelateDeps = { getClient };

// 404 → not_found (the only non-zero-exit-by-throw case).
const NOT_FOUND_RE = /not found/i;
// 409 → ambiguous shortId.
const AMBIGUOUS_RE = /ambiguous/i;
// 422 → a link that would close a cycle. Both server messages — the proven path
// and the fail-closed walk_cap precaution ("…would not create a cycle…") — carry
// the word "cycle", so this single fold covers both. NOT_FOUND_RE above is
// checked first and does not match "would not" (only the adjacent "not found").
const CYCLE_RE = /cycle/i;

export class LinkNotFoundError extends Error {
  constructor(which: "child" | "parent") {
    super(`Decision not found: ${which}`);
    this.name = "LinkNotFoundError";
  }
}

/** Caller-actionable rejections that map to a non-zero usage exit. */
export function isRelateRejection(outcome: RelateOutcome): boolean {
  return (
    outcome.outcome === "self_loop" ||
    outcome.outcome === "would_cycle" ||
    outcome.outcome === "ambiguous"
  );
}

// Reconstruct the rejection variants from the REST client's throw, or rethrow an
// unmapped error (transport / 5xx / org-unbound) for the global handler.
function foldRelateError(err: unknown): RelateOutcome {
  if (err instanceof Error) {
    if (NOT_FOUND_RE.test(err.message)) {
      throw new LinkNotFoundError(err.message.includes("parent") ? "parent" : "child");
    }
    if (AMBIGUOUS_RE.test(err.message)) {
      return { outcome: "ambiguous", which: err.message.includes("(parent)") ? "parent" : "child" };
    }
    if (CYCLE_RE.test(err.message)) {
      return { outcome: "would_cycle", detail: err.message };
    }
    // The remaining mapped 422 from link is the self-loop.
    if (/itself/i.test(err.message)) {
      return { outcome: "self_loop" };
    }
  }
  throw err;
}

async function relate(
  path: string,
  request: RelateRequest,
  deps: RelateDeps,
): Promise<RelateResult> {
  const client = deps.getClient();
  try {
    const outcome = (await client.post(path, request, {
      signal: AbortSignal.timeout(RELATE_TIMEOUT_MS),
    })) as RelateOutcome;
    return { request, outcome };
  } catch (err) {
    return { request, outcome: foldRelateError(err) };
  }
}

export function fetchLink(
  child: string,
  parent: string,
  deps: RelateDeps = defaultDeps,
): Promise<RelateResult> {
  return relate("/api/cli/decisions/link", { child, parent }, deps);
}

export function fetchUnlink(
  child: string,
  parent: string,
  deps: RelateDeps = defaultDeps,
): Promise<RelateResult> {
  return relate("/api/cli/decisions/unlink", { child, parent }, deps);
}

function endpointRef(outcome: RelateOutcome & RelateEndpoints, side: "child" | "parent"): string {
  return side === "child"
    ? renderIdentifier({ shortId: outcome.childShortId, id: outcome.childId })
    : renderIdentifier({ shortId: outcome.parentShortId, id: outcome.parentId });
}

export function formatRelateHuman(result: RelateResult): string {
  const { request, outcome } = result;
  switch (outcome.outcome) {
    case "linked":
      return `[prim] ${endpointRef(outcome, "child")} now depends on ${endpointRef(outcome, "parent")}.`;
    case "already_linked":
      return `[prim] ${endpointRef(outcome, "child")} already depends on ${endpointRef(outcome, "parent")}; nothing to change.`;
    case "unlinked":
      return `[prim] ${endpointRef(outcome, "child")} no longer depends on ${endpointRef(outcome, "parent")}.`;
    case "not_linked":
      return `[prim] ${endpointRef(outcome, "child")} did not depend on ${endpointRef(outcome, "parent")}; nothing to change.`;
    case "self_loop":
      return "[prim] a decision cannot depend on itself.";
    case "would_cycle":
      return `[prim] refusing to link — ${outcome.detail}.`;
    default: {
      const typed = outcome.which === "parent" ? request.parent : request.child;
      return `[prim] the ${outcome.which} id "${typed}" is ambiguous in this organization — retry with the full decision id.`;
    }
  }
}

export function formatRelateJson(result: RelateResult): string {
  return JSON.stringify(result.outcome, null, 2);
}
