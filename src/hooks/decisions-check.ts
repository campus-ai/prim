/**
 * Decision Graph check for prim.
 *
 * Calls GET /api/cli/decisions/affecting (repeated `files=` params, chunked
 * at the server's 25-path cap) to find active decisions that reference any
 * of the supplied files, then surfaces matches to STDERR (human-readable
 * warning) and STDOUT (JSON). Warn-only — never blocks the caller.
 *
 * When the check cannot be completed — org-unbound token, a truncated
 * result, or a transport/auth/validation failure — it reports an UNKNOWN
 * state (`unavailable` / `truncated`) rather than a silent all-clear, so a
 * "verified clear" is never confused with "we couldn't check".
 *
 * Two consumers:
 *   - `prim decisions check --files=...` (src/commands/decisions.ts)
 *   - the pre-commit hook (src/hooks/pre-commit.ts), run in parallel with
 *     syncAffectedSpecs.
 */
import { type CliClient, getClient } from "../client.js";

export interface ActiveDecisionSummary {
  id: string;
  intent: string;
  rationale?: string;
  status: "active" | "under_review";
  classifiedAt: number;
  matchedFiles: string[];
}

export interface DecisionsCheckResult {
  decisions: ActiveDecisionSummary[];
  /** True if any request hit the server's per-request path cap (partial). */
  truncated: boolean;
  /** Present when the check could not be completed (constraints UNKNOWN). */
  unavailable?: string;
}

export const DECISIONS_CHECK_TIMEOUT_MS = 10_000;
// Server caps each /affecting request at 25 paths (MAX_FILE_PATHS); send in
// chunks so a large commit gets a complete answer instead of a silent slice.
const MAX_FILES_PER_REQUEST = 25;

export interface CheckDeps {
  getClient: () => CliClient;
}

const defaultDeps: CheckDeps = { getClient };

type AffectingResponse = {
  decisions: ActiveDecisionSummary[];
  truncated?: boolean;
  unavailable?: string;
};

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

async function fetchAffecting(client: CliClient, batch: string[]): Promise<AffectingResponse> {
  const params = new URLSearchParams();
  for (const file of batch) {
    params.append("files", file);
  }
  try {
    return (await client.get(`/api/cli/decisions/affecting?${params.toString()}`, {
      signal: AbortSignal.timeout(DECISIONS_CHECK_TIMEOUT_MS),
    })) as AffectingResponse;
  } catch (err) {
    // A loud failure (network, auth, or the server's 400 on a bad path) must
    // report UNKNOWN, never a silent all-clear. Warn-only: the caller still
    // does not block.
    const detail = err instanceof Error ? err.message : String(err);
    return { decisions: [], truncated: false, unavailable: `decision check failed: ${detail}` };
  }
}

export async function checkAffectedDecisions(
  filePaths: string[],
  deps: CheckDeps = defaultDeps,
): Promise<DecisionsCheckResult> {
  if (filePaths.length === 0) {
    return { decisions: [], truncated: false };
  }
  const client = deps.getClient();
  const responses = await Promise.all(
    chunk(filePaths, MAX_FILES_PER_REQUEST).map((batch) => fetchAffecting(client, batch)),
  );

  const byId = new Map<string, ActiveDecisionSummary>();
  let truncated = false;
  let unavailable: string | undefined;
  for (const res of responses) {
    if (res.unavailable !== undefined && unavailable === undefined) {
      unavailable = res.unavailable;
    }
    truncated ||= res.truncated === true;
    for (const d of res.decisions) {
      const existing = byId.get(d.id);
      if (existing) {
        existing.matchedFiles = [...new Set([...existing.matchedFiles, ...d.matchedFiles])];
      } else {
        byId.set(d.id, { ...d, matchedFiles: [...d.matchedFiles] });
      }
    }
  }

  const result: DecisionsCheckResult = { decisions: [...byId.values()], truncated };
  if (unavailable !== undefined) {
    result.unavailable = unavailable;
  }
  return result;
}

const FILES_PREVIEW_LIMIT = 3;

export function formatDecisionsWarning(result: DecisionsCheckResult): string {
  const lines: string[] = [];
  if (result.unavailable !== undefined) {
    lines.push(`[prim] decision check not verified — ${result.unavailable}`);
  }
  if (result.decisions.length > 0) {
    lines.push(
      `[prim] ${String(result.decisions.length)} active decision(s) reference staged files:`,
    );
    for (const d of result.decisions) {
      const statusMark = d.status === "under_review" ? " (under review)" : "";
      const preview = d.matchedFiles.slice(0, FILES_PREVIEW_LIMIT).join(", ");
      const overflow =
        d.matchedFiles.length > FILES_PREVIEW_LIMIT
          ? ` (+${String(d.matchedFiles.length - FILES_PREVIEW_LIMIT)} more)`
          : "";
      lines.push(`  · ${d.intent}${statusMark}`);
      lines.push(`    files: ${preview}${overflow}`);
      if (d.rationale) {
        lines.push(`    rationale: ${d.rationale}`);
      }
    }
  }
  if (result.truncated) {
    lines.push(
      "[prim] result truncated — more files than the server checks per request; not all decisions shown",
    );
  }
  return lines.join("\n");
}
