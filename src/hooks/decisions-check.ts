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
 *   - the pre-commit hook (src/hooks/pre-commit.ts)
 */
import { type CliClient, getClient } from "../client.js";
import { daemonOrDirectGet } from "../daemon/proxy.js";
import { repoSyncId } from "../lib/activation.js";
import { canonicalGitRoot, canonicalRepositoryPath, currentBranch } from "../lib/git.js";
import { terminalSafeLine } from "../lib/terminal-safe.js";

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
  repoSyncId?: string;
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

async function fetchAffecting(
  client: CliClient,
  batch: string[],
  repository: { repoSyncId: string; branch?: string },
): Promise<AffectingResponse> {
  const params = new URLSearchParams();
  params.set("repoSyncId", repository.repoSyncId);
  if (repository.branch) params.set("branch", repository.branch);
  for (const file of batch) {
    params.append("files", file);
  }
  try {
    const response = await daemonOrDirectGet<AffectingResponse>(
      "decisions_affecting",
      `/api/cli/decisions/affecting?${params.toString()}`,
      client,
      DECISIONS_CHECK_TIMEOUT_MS,
    );
    // An older service ignores repository context and can silently miss scopes.
    if (response.repoSyncId !== repository.repoSyncId) {
      return {
        decisions: [],
        truncated: response.truncated === true,
        unavailable: response.unavailable ?? "service did not verify repository-scoped discovery",
      };
    }
    return response;
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
  const cwd = process.cwd();
  const root = canonicalGitRoot(cwd);
  const binding = repoSyncId(cwd);
  if (!root || !binding) {
    return {
      decisions: [],
      truncated: false,
      unavailable: "this checkout has no current Primitive repository binding; run prim enable",
    };
  }
  const canonical = filePaths.map((file) =>
    canonicalRepositoryPath(file, { repoRoot: root }, root),
  );
  if (canonical.some((path) => !path.ok)) {
    return {
      decisions: [],
      truncated: false,
      unavailable: "files must resolve inside this repository; use repository-relative paths",
    };
  }
  const paths = [...new Set(canonical.flatMap((path) => (path.ok ? [path.file] : [])))];
  const repository = { repoSyncId: binding, branch: currentBranch(cwd) };
  const client = deps.getClient();
  const responses = await Promise.all(
    chunk(paths, MAX_FILES_PER_REQUEST).map((batch) => fetchAffecting(client, batch, repository)),
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
    lines.push(`[prim] decision check not verified — ${terminalSafeLine(result.unavailable)}`);
  }
  if (result.decisions.length > 0) {
    lines.push(
      `[prim] ${String(result.decisions.length)} active decision(s) reference staged files:`,
    );
    for (const d of result.decisions) {
      const statusMark = d.status === "under_review" ? " (under review)" : "";
      const preview = d.matchedFiles.slice(0, FILES_PREVIEW_LIMIT).map(terminalSafeLine).join(", ");
      const overflow =
        d.matchedFiles.length > FILES_PREVIEW_LIMIT
          ? ` (+${String(d.matchedFiles.length - FILES_PREVIEW_LIMIT)} more)`
          : "";
      lines.push(`  · ${terminalSafeLine(d.intent)}${statusMark}`);
      lines.push(`    files: ${preview}${overflow}`);
      if (d.rationale) {
        lines.push(`    rationale: ${terminalSafeLine(d.rationale)}`);
      }
    }
  }
  if (result.truncated) {
    lines.push(
      "[prim] result truncated — a discovery scan or result limit was reached; not all decisions shown",
    );
  }
  return lines.join("\n");
}
