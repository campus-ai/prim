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

interface ServerSpecMapping {
  _id: string;
  name: string;
  filePatterns: string[];
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
function matchPattern(filePath: string, pattern: string): boolean {
  const regexStr = pattern
    .replaceAll("**", "§GLOBSTAR§")
    .replaceAll("*", "[^/]*")
    .replaceAll("§GLOBSTAR§", ".*");
  const regex = new RegExp(`^${regexStr}$`);
  return regex.test(filePath);
}

interface AffectedContext {
  contextId: string;
  matchedFiles: string[];
}

function findAffectedContexts(
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

const HOOK_TIMEOUT_MS = 10_000;

async function main() {
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    process.exit(0);
  }

  const client = getClient();
  let mappings: ServerSpecMapping[] = [];

  try {
    mappings = (await client.get("/api/cli/specs/mappings", {
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    })) as ServerSpecMapping[];
  } catch {
    process.exit(0);
  }

  if (mappings.length === 0) {
    process.exit(0);
  }

  const affectedContexts = findAffectedContexts(stagedFiles, mappings);

  if (affectedContexts.size === 0) {
    process.exit(0);
  }

  console.log(`[prim] ${String(affectedContexts.size)} spec(s) affected by staged changes:`);

  for (const [contextId] of affectedContexts) {
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

      await client.post(`/api/cli/contexts/${contextId}/sync`, undefined, {
        signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      });

      console.log(`  [synced] ${contextId} — ${(ctx.name as string) ?? "(unnamed)"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  [error] ${contextId} — ${message}`);
    }
  }

  process.exit(0);
}

main().catch((error) => {
  console.error("[prim] Pre-commit hook error:", error);
  // Don't block the commit
  process.exit(0);
});
