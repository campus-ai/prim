/**
 * `prim decisions recent` — chronological team-wide feed.
 *
 * Renders the chronological feed:
 *
 *   recent · 5 decisions · last 10 minutes
 *
 *     14:32  Maya              • data     Restrict PII storage to EU region
 *     14:35  Your Codex        • mobile   Rotate push tokens on auth refresh
 *     14:38  Sarah             • billing  17% discount on annual plans
 *     14:39  Your Claude Code  • auth     Server-side logout endpoint
 *     14:40  Jamal             • data     Move analytics warehouse to BigQuery
 *
 * STDOUT is the raw JSON response so agents can pipe it. STDERR is the
 * verdict-first human block above. Exit 0 on success including empty
 * results.
 *
 * UNKNOWN vs. empty: a healthy feed with zero rows ("0 decisions") must
 * never be confused with "we couldn't verify the feed." An expired token,
 * a down API, a malformed `--since` (server 400), or an org-unbound token
 * all carry an `unavailable` reason — the fetch records the reason rather
 * than masking it as a clean empty feed, and the human formatter surfaces
 * a "feed not verified — <reason>" line. Mirrors decisions-check.ts.
 */

import { type CliClient, getClient } from "../client.js";
import { daemonOrDirectGet } from "../daemon/proxy.js";
import { color, colorForArea } from "../lib/ansi.js";

export interface DecisionFeedRow {
  id: string;
  shortId: string | undefined;
  intent: string;
  rationale: string | undefined;
  area: string | undefined;
  producerKind: string | undefined;
  userId: string;
  authorName: string;
  authorIsSelf: boolean;
  classifiedAt: number;
  status: "active" | "superseded" | "under_review";
}

export interface DecisionsRecentResult {
  decisions: DecisionFeedRow[];
  /**
   * Present when the feed could not be verified (state UNKNOWN): an
   * org-unbound token (server returns this on a 200), or a thrown
   * transport/auth/validation error whose reason is recorded here.
   * Absent on a healthy feed — including a healthy feed of zero rows.
   */
  unavailable?: string;
}

/** Wire shape the server returns; `unavailable` arrives on org-unbound. */
type RecentResponse = {
  decisions: DecisionFeedRow[];
  unavailable?: string;
};

export const RECENT_TIMEOUT_MS = 10_000;

export interface RecentDeps {
  getClient: () => CliClient;
}

const defaultDeps: RecentDeps = { getClient };

export interface RecentArgs {
  limit?: number;
  since?: string;
}

export async function fetchRecent(
  args: RecentArgs,
  deps: RecentDeps = defaultDeps,
): Promise<DecisionsRecentResult> {
  const params = new URLSearchParams();
  if (args.limit !== undefined) {
    params.set("limit", String(args.limit));
  }
  if (args.since !== undefined) {
    params.set("since", args.since);
  }
  const client = deps.getClient();
  try {
    const res = await daemonOrDirectGet<RecentResponse>(
      "decisions_recent",
      `/api/cli/decisions/recent?${params.toString()}`,
      client,
      RECENT_TIMEOUT_MS,
    );
    // Read the server's `unavailable` through (org-unbound token → 200 with
    // an empty feed plus a reason). A healthy feed never carries it.
    const result: DecisionsRecentResult = { decisions: res.decisions };
    if (res.unavailable !== undefined) {
      result.unavailable = res.unavailable;
    }
    return result;
  } catch (err) {
    // Fail loud, not clean: a 401 (expired token), a 400 (bad --since), or a
    // network/timeout failure must surface as UNKNOWN, never as a healthy
    // "0 decisions". Record the reason instead of masking it.
    const detail = err instanceof Error ? err.message : String(err);
    return { decisions: [], unavailable: `recent feed failed: ${detail}` };
  }
}

const SHORT_ID_PREFIX = "dec_";
const ZERO_PAD_TWO = 2;

function pad2(n: number): string {
  return n.toString().padStart(ZERO_PAD_TWO, "0");
}

function formatClock(ms: number): string {
  const d = new Date(ms);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

function authorLabel(row: DecisionFeedRow): string {
  if (!row.authorIsSelf) {
    return row.authorName;
  }
  // "Your Codex" / "Your Claude Code" / "Your chat" — drive off the
  // producerKind.
  switch (row.producerKind) {
    case "claude_code":
      return "Your Claude Code";
    case "codex":
      return "Your Codex";
    case "chat":
      return "Your chat";
    case "spec_edit":
      return "Your spec edit";
    case "cli":
      return "Your CLI";
    default:
      return `Your ${row.authorName}`;
  }
}

const AUTHOR_WIDTH = 18;

function padRight(s: string, width: number): string {
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s.padEnd(width, " ");
}

export function formatRecentHuman(result: DecisionsRecentResult): string {
  // UNKNOWN beats empty: when the feed couldn't be verified, never render a
  // clean "0 decisions" the reader would trust as a healthy all-clear.
  if (result.unavailable !== undefined) {
    return `[prim] recent · feed not verified — ${result.unavailable}`;
  }
  if (result.decisions.length === 0) {
    return "[prim] recent · 0 decisions";
  }
  const lines = [`[prim] recent · ${String(result.decisions.length)} decision(s)`];
  for (const row of result.decisions) {
    const clock = formatClock(row.classifiedAt);
    const author = padRight(authorLabel(row), AUTHOR_WIDTH);
    // Pad the plain (uncolored) form to maintain alignment, then color
    // the bullet alone — the visible width stays the same regardless
    // of color, so columns line up under both TTY and piped output.
    const areaText = row.area ? `• ${row.area}` : "•";
    const areaPlain = padRight(areaText, 12);
    const areaCol = row.area
      ? areaPlain.replace("•", color("•", colorForArea(row.area)))
      : areaPlain;
    lines.push(`  ${clock}  ${author}${areaCol}${row.intent}`);
  }
  return lines.join("\n");
}

export function formatRecentJson(result: DecisionsRecentResult): string {
  return JSON.stringify(result, null, 2);
}

/**
 * Render the rendered short identifier (e.g., `dec_8c2f1a07`) when
 * present; otherwise fall back to the raw Convex `_id` so the CLI
 * never shows a blank in front of a real decision. Kept as a helper
 * because both `recent` and `show` rendering need it.
 */
export function renderIdentifier(row: {
  shortId?: string | undefined;
  id: string;
}): string {
  if (row.shortId) {
    return `${SHORT_ID_PREFIX}${row.shortId}`;
  }
  return row.id;
}
