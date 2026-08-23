/**
 * Verdict-footer renderer for `prim-post-tool-use`.
 *
 * The cli's PostToolUse hook reads the server's `verdictFooter` field off the
 * `/api/cli/moves/ingest` response. When non-null — meaning the user's
 * just-completed Edit landed within the footer window of consuming a reconcile
 * bypass — render it to STDERR:
 *
 *     ✓ Conflict caught before merge · N decisions saved · X's intent preserved
 *
 * The decision count is the reconciled decision's direct live-dependent count;
 * when the server caps that count it sets `decisionsSavedTruncated`, and the
 * footer renders `N+` so a capped count is never reported as exact.
 *
 * Color:
 *   - the "✓ Conflict caught" segment renders green so the success state pops
 *   - the author name renders bold so "X's intent preserved" reads like the
 *     human-attributed credit it is
 *
 * Pure render module — the hook calls `renderVerdictFooter`. Testable without
 * an HTTP fetcher or stdin/stdout plumbing.
 */

import { bold, color } from "../lib/ansi.js";
import { terminalSafeLine } from "../lib/terminal-safe.js";

// Mirrors the server's VerdictFooterContext verbatim (even the fields the
// renderer doesn't print) so the wire shape is tracked in one place.
export interface VerdictFooterContext {
  author: string;
  intent: string;
  decisionsSaved: number;
  decisionsSavedTruncated: boolean;
  decisionId: string;
  decisionShortId: string | undefined;
}

export function renderVerdictFooter(ctx: VerdictFooterContext): string {
  const successPrefix = color("✓ Conflict caught before merge", "green");
  const savedCount = `${String(ctx.decisionsSaved)}${ctx.decisionsSavedTruncated ? "+" : ""}`;
  const savedFragment = `${savedCount} decisions saved`;
  const intentFragment = `${bold(terminalSafeLine(ctx.author))}'s intent preserved`;
  return `${successPrefix} · ${savedFragment} · ${intentFragment}`;
}

/**
 * Type-guard for the server's verdictFooter payload. The
 * `/api/cli/moves/ingest` response is `{ accepted, verdictFooter }` where
 * `verdictFooter` is `null` in the common case (no recently-consumed bypass).
 * `decisionShortId` is intentionally not gated — the server sends it as
 * `string | undefined`.
 */
export function isVerdictFooterContext(value: unknown): value is VerdictFooterContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.author === "string" &&
    typeof v.intent === "string" &&
    typeof v.decisionsSaved === "number" &&
    typeof v.decisionsSavedTruncated === "boolean" &&
    typeof v.decisionId === "string"
  );
}
