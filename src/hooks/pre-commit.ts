#!/usr/bin/env node
/**
 * Pre-commit hook for automatic spec sync.
 *
 * When a developer commits code, this hook:
 * 1. Fetches specs with file patterns from the server
 * 2. Identifies which specs are affected by matching staged files
 *    against each spec's file patterns
 * 3. For each affected spec, triggers a sync via the CLI REST API
 *
 * Install: prim hooks install
 *
 * Server-side setup:
 *   prim spec map <specId> --pattern "src/auth/**"
 */
import { execSync } from "node:child_process";
import { getClient } from "../client.js";
import { type GitContext, getGitContext } from "../utils/git.js";

export interface ServerSpecMapping {
  _id: string;
  name: string;
  filePatterns: string[];
  linkedBranches?: Array<{
    branch: string;
    prNumber?: number;
    prState?: "draft" | "open" | "closed" | "merged";
    prReviewDecision?: "approved" | "changes_requested" | "review_required";
  }>;
}

function getStagedFiles(): string[] {
  const output = execSync("git diff --cached --name-only", {
    encoding: "utf-8",
  });
  return output
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

function getStagedDiff(files: string[]): string {
  return execSync(`git diff --cached -- ${files.map((f) => `"${f}"`).join(" ")}`, {
    encoding: "utf-8",
  });
}

/**
 * Simple glob-style matching: supports * and ** wildcards.
 */
export function matchPattern(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replaceAll("**", "§GLOBSTAR§")
    .replaceAll("*", "[^/]*")
    .replaceAll("§GLOBSTAR§", ".*");
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

export interface AffectedContext {
  contextId: string;
  matchedFiles: string[];
}

export interface SyncDiffResponse {
  analyzing: boolean;
  truncated?: boolean;
  sizeChars?: number;
  limitChars?: number;
}

export function findAffectedContexts(
  stagedFiles: string[],
  specs: ServerSpecMapping[],
): Map<string, AffectedContext> {
  const affected = new Map<string, AffectedContext>();

  for (const file of stagedFiles) {
    for (const spec of specs) {
      for (const pattern of spec.filePatterns) {
        if (matchPattern(file, pattern)) {
          const existing = affected.get(spec._id);
          if (existing) {
            existing.matchedFiles.push(file);
          } else {
            affected.set(spec._id, {
              contextId: spec._id,
              matchedFiles: [file],
            });
          }
          break; // One match per spec is enough
        }
      }
    }
  }

  return affected;
}

export const HOOK_TIMEOUT_MS = 10_000;

export interface SyncDeps {
  getClient: () => import("../client.js").CliClient;
  getStagedFiles: () => string[];
  getStagedDiff: (files: string[]) => string;
  getGitContext: () => GitContext;
}

const defaultDeps: SyncDeps = {
  getClient,
  getStagedFiles,
  getStagedDiff,
  getGitContext,
};

export async function syncAffectedSpecs(deps: SyncDeps = defaultDeps): Promise<string[]> {
  const stagedFiles = deps.getStagedFiles();
  if (stagedFiles.length === 0) {
    return [];
  }

  const client = deps.getClient();
  const gitCtx = deps.getGitContext();

  let mappingsUrl = "/api/cli/specs/mappings";
  if (gitCtx.repoFullName && gitCtx.branch) {
    const params = new URLSearchParams({
      repoFullName: gitCtx.repoFullName,
      branch: gitCtx.branch,
    });
    mappingsUrl = `${mappingsUrl}?${params.toString()}`;
  }

  let mappings: ServerSpecMapping[] = [];

  try {
    mappings = (await client.get(mappingsUrl, {
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    })) as ServerSpecMapping[];
  } catch {
    return [];
  }

  if (mappings.length === 0) {
    return [];
  }

  const specsById = new Map(mappings.map((s) => [s._id, s]));
  const affectedContexts = findAffectedContexts(stagedFiles, mappings);

  if (affectedContexts.size === 0) {
    return [];
  }

  console.log(`[prim] ${String(affectedContexts.size)} spec(s) affected by staged changes:`);

  const synced: string[] = [];

  for (const [contextId, affected] of affectedContexts) {
    try {
      const ctx = (await client.get(`/api/cli/contexts/${contextId}`, {
        signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      })) as Record<string, unknown>;

      if (!ctx._id) {
        console.log(`  [skip] ${contextId} — not found`);
        continue;
      }

      if (!ctx.isSpecDocument) {
        console.log(`  [skip] ${contextId} — not a spec document`);
        continue;
      }

      const diffContent = deps.getStagedDiff(affected.matchedFiles);
      if (!diffContent) {
        console.log(`  [skip] ${contextId} — no diff content`);
        continue;
      }

      const response = (await client.post(
        `/api/cli/contexts/${contextId}/sync-diff`,
        { diffContent, affectedFiles: affected.matchedFiles },
        { signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) },
      )) as SyncDiffResponse;

      const name = (ctx.name as string) ?? "(unnamed)";
      const spec = specsById.get(contextId);
      const link = spec?.linkedBranches?.find((l) => l.branch === gitCtx.branch);
      let linkSuffix = "";
      if (link) {
        const prBits = link.prNumber
          ? ` #${String(link.prNumber)}${link.prState ? ` ${link.prState}` : ""}`
          : "";
        linkSuffix = ` (linked to ${link.branch}${prBits})`;
      } else if (gitCtx.branch && spec?.linkedBranches?.length === 0) {
        linkSuffix = ` (auto-linking to ${gitCtx.branch})`;
      }
      if (response.truncated && response.sizeChars && response.limitChars) {
        const sizeKiB = Math.round(response.sizeChars / 1024);
        const limitKiB = Math.round(response.limitChars / 1024);
        console.log(
          `  [synced] ${contextId} — ${name} (truncated: ${String(sizeKiB)} KiB → ${String(limitKiB)} KiB analyzed)${linkSuffix}`,
        );
      } else {
        console.log(`  [synced] ${contextId} — ${name}${linkSuffix}`);
      }
      synced.push(contextId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  [error] ${contextId} — ${message}`);
    }
  }

  return synced;
}

async function main() {
  await syncAffectedSpecs();
  process.exit(0);
}

// Skip auto-run during tests
if (!process.env.VITEST) {
  main().catch((error) => {
    console.error("[prim] Pre-commit hook error:", error);
    // Don't block the commit
    process.exit(0);
  });
}
