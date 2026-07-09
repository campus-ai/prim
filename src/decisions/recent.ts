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
   * Whether the requesting viewer has authored any decision in this org —
   * the welcome flow seeds a member who hasn't, regardless of the org's
   * own history. Absent on the org-unbound branch (the server omits it
   * when it sets `unavailable`) and on a pre-flag backend, so consumers
   * must treat absent as "unknown", never as "has decisions".
   */
  viewerHasDecisions?: boolean;
  /**
   * The org member the server resolved an `author` filter to. Present
   * on every author-filtered response — including zero-row pages; a
   * response to an author request that carries neither this echo nor
   * `unavailable` came from a backend that ignored the filter, and
   * fetchRecent converts it to UNKNOWN rather than presenting the
   * unfiltered team feed as one person's decisions.
   */
  author?: { userId: string; name: string };
  /**
   * Whether the resolved author has any FEED-VISIBLE decision in this
   * org (the server counts only status-stamped rows — legacy rows
   * pending the status backfill don't count, matching what any feed
   * view can show). The decisive split between "none the feed can
   * show" (false) and "has decisions, none surfaced on this page"
   * (true with zero rows — they may sit outside the window OR deeper
   * than the scan, behind non-decision captures). Only rides
   * author-filtered responses.
   */
  authorHasDecisions?: boolean;
  /**
   * Present when the feed could not be verified (state UNKNOWN): an
   * org-unbound token (server returns this on a 200), an unknown or
   * ambiguous `author` name, or a thrown transport/auth/validation
   * error whose reason is recorded here. Absent on a healthy feed —
   * including a healthy feed of zero rows.
   */
  unavailable?: string;
}

/**
 * Wire shape the server returns; `unavailable` arrives on org-unbound
 * and on unknown/ambiguous author names.
 */
type RecentResponse = {
  decisions: DecisionFeedRow[];
  viewerHasDecisions?: boolean;
  author?: { userId: string; name: string };
  authorHasDecisions?: boolean;
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
  author?: string;
}

export async function fetchRecent(
  args: RecentArgs,
  deps: RecentDeps = defaultDeps,
): Promise<DecisionsRecentResult> {
  // Reject an empty author locally, before any transport: the new
  // backend 400s it, but an OLD backend ignores the unknown param and
  // returns the org feed without an echo — which the skew guard below
  // would misreport as a backend-version problem when the real problem
  // is the caller's empty flag.
  if (args.author !== undefined && args.author.trim() === "") {
    return {
      decisions: [],
      unavailable: "--author must be a non-empty name",
    };
  }
  const params = new URLSearchParams();
  if (args.limit !== undefined) {
    params.set("limit", String(args.limit));
  }
  if (args.since !== undefined) {
    params.set("since", args.since);
  }
  if (args.author !== undefined) {
    params.set("author", args.author);
  }
  try {
    // Inside the try so any future eager I/O in getClient surfaces as UNKNOWN
    // rather than a throw — `prim welcome` leans on fetchRecent never rejecting.
    const client = deps.getClient();
    const res = await daemonOrDirectGet<RecentResponse>(
      "decisions_recent",
      `/api/cli/decisions/recent?${params.toString()}`,
      client,
      RECENT_TIMEOUT_MS,
    );
    // Version-skew guard: a backend that predates author filtering ignores
    // the unknown param and returns the UNFILTERED team feed. The new server
    // echoes `author` on every response where it applied the filter (zero-row
    // pages included), so no echo and no `unavailable` means the filter was
    // ignored — surface UNKNOWN, never someone else's rows as the author's.
    if (args.author !== undefined && res.author === undefined && res.unavailable === undefined) {
      return {
        decisions: [],
        unavailable:
          "--author requires a newer Primitive backend (no author echo in response); retry without --author for the team-wide feed",
      };
    }
    // Read the server's `unavailable` through (org-unbound token or an
    // unknown/ambiguous author → 200 with an empty feed plus a reason).
    // A healthy feed never carries it.
    const result: DecisionsRecentResult = { decisions: res.decisions };
    if (res.viewerHasDecisions !== undefined) {
      result.viewerHasDecisions = res.viewerHasDecisions;
    }
    if (res.author !== undefined) {
      result.author = res.author;
    }
    if (res.authorHasDecisions !== undefined) {
      result.authorHasDecisions = res.authorHasDecisions;
    }
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
    case "hermes":
      return "Your Hermes";
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
const AREA_WIDTH = 12;

function padRight(s: string, width: number): string {
  return s.length >= width ? `${s.slice(0, width - 1)} ` : s.padEnd(width, " ");
}

/**
 * Render one feed row: `  HH:MM  author<pad>• area<pad>intent`. Extracted from
 * the human formatter so `prim welcome` can inline the latest few decisions with
 * byte-identical formatting. Pad the plain (uncolored) form to maintain
 * alignment, then color the bullet alone — the visible width stays the same
 * regardless of color, so columns line up under both TTY and piped output.
 */
export function formatRecentRow(row: DecisionFeedRow): string {
  const clock = formatClock(row.classifiedAt);
  const author = padRight(authorLabel(row), AUTHOR_WIDTH);
  const areaText = row.area ? `• ${row.area}` : "•";
  const areaPlain = padRight(areaText, AREA_WIDTH);
  const areaCol = row.area ? areaPlain.replace("•", color("•", colorForArea(row.area))) : areaPlain;
  return `  ${clock}  ${author}${areaCol}${row.intent}`;
}

export function formatRecentHuman(result: DecisionsRecentResult): string {
  // UNKNOWN beats empty: when the feed couldn't be verified, never render a
  // clean "0 decisions" the reader would trust as a healthy all-clear.
  if (result.unavailable !== undefined) {
    return `[prim] recent · feed not verified — ${result.unavailable}`;
  }
  if (result.author !== undefined && result.decisions.length === 0) {
    // Author-filtered empties are two DIFFERENT truths — say which one.
    // The server always sends authorHasDecisions on a resolved author
    // (zero-row pages included); an absent flag is an intermediate
    // backend we make no strong claim about — neutral line, never
    // "never captured" on missing evidence.
    if (result.authorHasDecisions === true) {
      // Say only what the flag attests: the author HAS feed-visible
      // decisions, just none on this page. Never claim the missing rows
      // are "older" — the feed reads newest-first and post-filters
      // non-decision captures, so the page can starve on a run of
      // hidden rows while visible decisions sit deeper in the SAME
      // window. --limit is the remedy that reaches past that run;
      // --since only helps when the window itself is the problem, so
      // it is offered second.
      return `[prim] recent · ${result.author.name} · 0 decisions surfaced in this window (they have decisions — raise --limit to reach past non-decision captures, or widen --since)`;
    }
    if (result.authorHasDecisions === false) {
      return `[prim] recent · ${result.author.name} · no feed-visible decisions yet (if unexpected, check prim setup/doctor on their machine and the repo they work in)`;
    }
    return `[prim] recent · ${result.author.name} · 0 decisions`;
  }
  const label = result.author === undefined ? "recent" : `recent · ${result.author.name}`;
  if (result.decisions.length === 0) {
    return "[prim] recent · 0 decisions";
  }
  const lines = [`[prim] ${label} · ${String(result.decisions.length)} decision(s)`];
  for (const row of result.decisions) {
    lines.push(formatRecentRow(row));
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
