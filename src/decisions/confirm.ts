/**
 * `prim decisions confirm <idOrShortId> [--reject]` — answer a Phase C
 * confirmation prompt without opening the browser.
 *
 * Default behavior is "yes, the inferred rationale is correct";
 * `--reject` flips the request to `confirmed=false`. The request intent
 * (confirmed vs rejected) is the CLI's only input — it is NOT echoed in
 * every server outcome, so the verdict wording for the freshly-applied
 * variants is derived from that intent here.
 *
 * The server answers with a discriminated `ConfirmOutcome` union keyed
 * on `outcome`. The happy outcomes (`confirmed` / `corrected` / `stale`)
 * and the two terminal-but-not-error outcomes (`already_responded`,
 * `no_pending_prompt`) arrive as the 2xx body. The error outcomes the
 * server expresses as HTTP status instead — 404 not_found, 409 ambiguous
 * shortId, 403 not_author — surface through the REST client's throw. We
 * map those back onto the same union so a single formatter switch covers
 * every case: 404 becomes a {@link ConfirmNotFoundError} (the command
 * maps it to exit 4); 409 and 403/not_author resolve to clean, distinct
 * verdict lines rather than crashing as unhandled throws.
 *
 * AX contract: STDOUT is machine-readable JSON (formatConfirmJson),
 * STDERR is verdict-first human text (formatConfirmHuman). Exit 0 in
 * every resolved case (including the idempotent already-answered and the
 * nothing-to-acknowledge no-ops); exit ≠ 0 only on auth/network failure
 * or not-found.
 */

import { type CliClient, getClient } from "../client.js";
import { renderIdentifier } from "./recent.js";

/**
 * The request intent the CLI carried in (confirmed vs rejected). The
 * freshly-applied server outcomes (`confirmed` / `corrected` / `stale`)
 * do not echo a `confirmed` field, so the verdict wording is derived
 * from this rather than the response.
 */
export interface ConfirmRequest {
  idOrShortId: string;
  confirmed: boolean;
}

/**
 * Mirror of the server's `ConfirmOutcome` discriminated union, narrowed
 * to the variants a CLI caller can observe. The three error variants the
 * server returns as HTTP status (not_found / ambiguous / not_author) are
 * reconstructed from the thrown error so the formatters can switch over
 * one shape. `not_found` is intentionally absent — it throws
 * {@link ConfirmNotFoundError} for exit 4 instead.
 */
export type ConfirmOutcome =
  | {
      outcome: "confirmed" | "corrected" | "stale";
      decisionId: string;
      shortId: string | undefined;
    }
  | {
      outcome: "already_responded";
      decisionId: string;
      shortId: string | undefined;
      confirmed: boolean | undefined;
      respondedAt: number;
    }
  | { outcome: "no_pending_prompt"; decisionId: string; shortId: string | undefined }
  | { outcome: "ambiguous" }
  | { outcome: "not_author" };

/**
 * Carries the original request intent alongside the server outcome so
 * the formatters can word the freshly-applied variants ("confirmed" /
 * "rejected") without the server having to echo it back.
 */
export interface ConfirmResult {
  request: ConfirmRequest;
  outcome: ConfirmOutcome;
}

export const CONFIRM_TIMEOUT_MS = 10_000;

export interface ConfirmDeps {
  getClient: () => CliClient;
}

const defaultDeps: ConfirmDeps = { getClient };

// Declared at top level (regex literals must not be rebuilt per call).
// 404 → not_found; the only outcome that maps to a non-zero exit.
const NOT_FOUND_RE = /not found/i;
// 409 → ambiguous shortId.
const AMBIGUOUS_RE = /ambiguous/i;
// 403 → not_author. The org-unbound 403 ("not bound to an organization")
// is deliberately NOT matched here so it falls through as a generic auth
// failure rather than masquerading as an authorship rejection.
const NOT_AUTHOR_RE = /author/i;

export class ConfirmNotFoundError extends Error {
  constructor(idOrShortId: string) {
    super(`Decision not found: ${idOrShortId}`);
    this.name = "ConfirmNotFoundError";
  }
}

export async function fetchConfirm(
  idOrShortId: string,
  confirmed: boolean,
  deps: ConfirmDeps = defaultDeps,
): Promise<ConfirmResult> {
  const request: ConfirmRequest = { idOrShortId, confirmed };
  const client = deps.getClient();
  try {
    // The CLI sends only { id, confirmed }; `correction` is deferred
    // (F13) and intentionally omitted from the body.
    const outcome = (await client.post(
      "/api/cli/decisions/confirm",
      { id: idOrShortId, confirmed },
      { signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS) },
    )) as ConfirmOutcome;
    return { request, outcome };
  } catch (err) {
    if (err instanceof Error) {
      if (NOT_FOUND_RE.test(err.message)) {
        throw new ConfirmNotFoundError(idOrShortId);
      }
      if (AMBIGUOUS_RE.test(err.message)) {
        return { request, outcome: { outcome: "ambiguous" } };
      }
      if (NOT_AUTHOR_RE.test(err.message)) {
        return { request, outcome: { outcome: "not_author" } };
      }
    }
    throw err;
  }
}

function intentWord(confirmed: boolean): string {
  return confirmed ? "confirmed" : "rejected";
}

export function formatConfirmHuman(result: ConfirmResult): string {
  const { request, outcome } = result;
  switch (outcome.outcome) {
    case "confirmed":
    case "corrected":
    case "stale": {
      const id = renderIdentifier({ shortId: outcome.shortId, id: outcome.decisionId });
      if (outcome.outcome === "stale") {
        return `[prim] ${id} ${intentWord(request.confirmed)} — the prompt had gone stale; recorded against the current decision.`;
      }
      if (outcome.outcome === "corrected") {
        return `[prim] ${id} ${intentWord(request.confirmed)} with a correction.`;
      }
      return `[prim] ${id} ${intentWord(request.confirmed)}.`;
    }
    case "already_responded": {
      const id = renderIdentifier({ shortId: outcome.shortId, id: outcome.decisionId });
      const priorWord =
        outcome.confirmed === undefined
          ? "already answered"
          : `already ${intentWord(outcome.confirmed)}`;
      const when = new Date(outcome.respondedAt).toISOString();
      return `[prim] ${id} was ${priorWord} (responded ${when}); nothing to change.`;
    }
    case "no_pending_prompt": {
      const id = renderIdentifier({ shortId: outcome.shortId, id: outcome.decisionId });
      return `[prim] ${id} has no pending confirmation request — nothing to acknowledge.`;
    }
    case "ambiguous":
      return `[prim] shortId "${request.idOrShortId}" is ambiguous in this organization — retry with the full decision id.`;
    default:
      // The only remaining variant — `not_author`. TypeScript narrows
      // `outcome` to it here, so the union stays exhaustively covered.
      return "[prim] only the decision's author can respond to its confirmation prompt.";
  }
}

export function formatConfirmJson(result: ConfirmResult): string {
  return JSON.stringify(result.outcome, null, 2);
}
