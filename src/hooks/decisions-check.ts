/**
 * Decision Graph check for prim.
 *
 * Calls GET /api/cli/decisions/affecting?files=... to look up active
 * engineering decisions that reference any of the supplied files,
 * then surfaces matches to STDERR (human-readable warning block) and
 * STDOUT (JSON). Warn-only — never blocks the caller. Failure modes
 * (network, auth, missing endpoint on older server) return an empty
 * result so the pre-commit hook stays silent rather than scary.
 *
 * Two consumers:
 *   - `prim decisions check --files=...` subcommand
 *     (src/commands/decisions.ts)
 *   - The pre-commit hook (src/hooks/pre-commit.ts) runs this in
 *     parallel with `syncAffectedSpecs`.
 *
 * See deep-foraging-boot.md PR 5b.
 */
import { type CliClient, getClient } from "../client.js";

export interface ActiveDecisionSummary {
  id: string;
  intent: string;
  rationale: string;
  status: "active" | "under_review";
  classifiedAt: number;
  matchedFiles: string[];
}

export interface DecisionsCheckResult {
  decisions: ActiveDecisionSummary[];
}

export const DECISIONS_CHECK_TIMEOUT_MS = 10_000;

export interface CheckDeps {
  getClient: () => CliClient;
}

const defaultDeps: CheckDeps = {
  getClient,
};

export async function checkAffectedDecisions(
  filePaths: string[],
  deps: CheckDeps = defaultDeps,
): Promise<DecisionsCheckResult> {
  if (filePaths.length === 0) {
    return { decisions: [] };
  }
  const client = deps.getClient();
  const params = new URLSearchParams({ files: filePaths.join(",") });
  try {
    return (await client.get(`/api/cli/decisions/affecting?${params.toString()}`, {
      signal: AbortSignal.timeout(DECISIONS_CHECK_TIMEOUT_MS),
    })) as DecisionsCheckResult;
  } catch {
    return { decisions: [] };
  }
}

const FILES_PREVIEW_LIMIT = 3;
const NO_RATIONALE_TEXT = "(no rationale recorded)";

export function formatDecisionsWarning(result: DecisionsCheckResult): string {
  if (result.decisions.length === 0) {
    return "";
  }
  const lines = [
    `[prim] ${String(result.decisions.length)} active decision(s) reference staged files:`,
  ];
  for (const d of result.decisions) {
    const statusMark = d.status === "under_review" ? " (under review)" : "";
    const preview = d.matchedFiles.slice(0, FILES_PREVIEW_LIMIT).join(", ");
    const overflow =
      d.matchedFiles.length > FILES_PREVIEW_LIMIT
        ? ` (+${String(d.matchedFiles.length - FILES_PREVIEW_LIMIT)} more)`
        : "";
    lines.push(`  · ${d.intent}${statusMark}`);
    lines.push(`    files: ${preview}${overflow}`);
    if (d.rationale && d.rationale !== NO_RATIONALE_TEXT) {
      lines.push(`    rationale: ${d.rationale}`);
    }
  }
  return lines.join("\n");
}
