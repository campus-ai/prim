/**
 * Image-#3 verdict footer renderer for `prim-post-tool-use`.
 *
 * The cli's PostToolUse hook reads the M9 server's `verdictFooter`
 * field off the `/api/cli/moves/ingest` response. When non-null —
 * meaning the user's just-completed Edit landed within 60s of
 * consuming a reconcile bypass — render to STDERR:
 *
 *     ✓ Conflict caught before merge · N decisions saved · X's intent preserved
 *
 * Color (M7 ANSI helpers):
 *   - the ✓ glyph and the "Conflict caught" segment render green
 *     so the success state pops at-a-glance
 *   - the author name renders bold so the "X's intent preserved"
 *     fragment reads like the human-attributed credit it is
 *
 * Pure render module — the hook calls `renderVerdictFooter`. Testable
 * without an HTTP fetcher or stdin/stdout plumbing.
 */

import { bold, color } from "../lib/ansi.js";

export interface VerdictFooterContext {
  decisionsSaved: number;
  author: string;
  intent: string;
}

export function renderVerdictFooter(ctx: VerdictFooterContext): string {
  const successPrefix = color("✓ Conflict caught before merge", "green");
  const savedFragment = `${String(ctx.decisionsSaved)} decisions saved`;
  const intentFragment = `${bold(ctx.author)}'s intent preserved`;
  return `${successPrefix} · ${savedFragment} · ${intentFragment}`;
}

/**
 * Type-guard for the server's verdictFooter payload. The
 * `/api/cli/moves/ingest` response shape is `{accepted, verdictFooter}`
 * where `verdictFooter` is `null` when no bypass was recently consumed.
 */
export function isVerdictFooterContext(value: unknown): value is VerdictFooterContext {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return (
    typeof v.decisionsSaved === "number" &&
    typeof v.author === "string" &&
    typeof v.intent === "string"
  );
}
