#!/usr/bin/env node
/**
 * Pre-commit hook for automatic spec/context updates.
 *
 * When a developer commits code, this hook:
 * 1. Fetches specs with file patterns from the server
 * 2. Identifies which specs are affected by matching staged files
 *    against each spec's file patterns
 * 3. For each affected spec, triggers a sync via the CLI REST API
 *
 * Install: prim hooks install
 * Or manually: cp this file to .git/hooks/pre-commit && chmod +x .git/hooks/pre-commit
 *
 * Server-side setup:
 *   prim spec map <specId> --pattern "src/auth/**"
 *
 * Local settings (.primrc.json, optional):
 * {
 *   "analyzeChanges": true,
 *   "sessionNotesFile": ".prim-session.md"
 * }
 *
 * Legacy: .primrc.json specMappings are still supported as a fallback
 * when the server is unreachable.
 */
import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getClient } from "../client.js";

interface ServerSpecMapping {
  _id: string;
  name: string;
  filePatterns: string[];
}

interface LegacySpecMapping {
  filePattern: string;
  contextId: string;
}

interface PrimConfig {
  specMappings?: LegacySpecMapping[];
  analyzeChanges?: boolean;
  sessionNotesFile?: string;
}

function loadLocalConfig(): PrimConfig {
  const configPath = resolve(process.cwd(), ".primrc.json");
  if (!existsSync(configPath)) return {};

  const content = readFileSync(configPath, "utf-8");
  return JSON.parse(content) as PrimConfig;
}

function convertLegacyMappings(legacy: LegacySpecMapping[]): ServerSpecMapping[] {
  const byContext = new Map<string, string[]>();
  for (const m of legacy) {
    const patterns = byContext.get(m.contextId) ?? [];
    patterns.push(m.filePattern);
    byContext.set(m.contextId, patterns);
  }
  return [...byContext.entries()].map(([id, patterns]) => ({
    _id: id,
    name: "(from .primrc.json)",
    filePatterns: patterns,
  }));
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

const MAX_DIFF_BYTES = 10_240;

function getStagedDiffForFiles(files: string[]): string {
  if (files.length === 0) return "";
  const fileArgs = files.map((f) => `"${f}"`).join(" ");
  return execSync(`git diff --cached -- ${fileArgs}`, {
    encoding: "utf-8",
    maxBuffer: MAX_DIFF_BYTES * 2,
  }).slice(0, MAX_DIFF_BYTES);
}

const MAX_SESSION_NOTES_BYTES = 20_480;

function readSessionNotes(config: PrimConfig): string | undefined {
  const notesPath = resolve(process.cwd(), config.sessionNotesFile ?? ".prim-session.md");
  if (!existsSync(notesPath)) return undefined;

  const content = readFileSync(notesPath, "utf-8").trim();
  if (content.length === 0) return undefined;

  return content.length > MAX_SESSION_NOTES_BYTES
    ? content.slice(0, MAX_SESSION_NOTES_BYTES)
    : content;
}

const HOOK_TIMEOUT_MS = 10_000;

async function main() {
  const localConfig = loadLocalConfig();

  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    process.exit(0);
  }

  const client = getClient();
  let mappings: ServerSpecMapping[] = [];

  // Try server-side mappings first, fall back to legacy .primrc.json
  try {
    mappings = (await client.get("/api/cli/specs/mappings", {
      signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
    })) as ServerSpecMapping[];
  } catch {
    const legacy = localConfig.specMappings ?? [];
    if (legacy.length > 0) {
      console.log("[prim] Server unreachable, falling back to .primrc.json specMappings");
      mappings = convertLegacyMappings(legacy);
    }
  }

  if (mappings.length === 0) {
    process.exit(0);
  }

  const affectedContexts = findAffectedContexts(stagedFiles, mappings);

  if (affectedContexts.size === 0) {
    process.exit(0);
  }

  const useAnalysis = localConfig.analyzeChanges === true;
  const sessionNotes = useAnalysis ? readSessionNotes(localConfig) : undefined;

  const notesLabel = sessionNotes ? ", with session notes" : "";
  console.log(
    `[prim] ${String(affectedContexts.size)} spec(s) affected by staged changes${useAnalysis ? ` (with diff analysis${notesLabel})` : ""}:`,
  );

  for (const [contextId, affected] of affectedContexts) {
    try {
      // Fetch the current spec
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

      if (useAnalysis) {
        // Capture diff for matched files and send for LLM analysis
        const diffContent = getStagedDiffForFiles(affected.matchedFiles);
        if (diffContent.length > 0 && diffContent.length <= MAX_DIFF_BYTES) {
          await client.post(
            `/api/cli/contexts/${contextId}/sync-diff`,
            {
              diffContent,
              affectedFiles: affected.matchedFiles,
              sessionNotes,
            },
            { signal: AbortSignal.timeout(HOOK_TIMEOUT_MS) },
          );
          console.log(`  [analyzing] ${contextId} — ${(ctx.name as string) ?? "(unnamed)"}`);
          continue;
        }
        // Diff too large or empty — fall back to regular sync
      }

      // Regular sync (re-validate existing spec)
      await client.post(`/api/cli/contexts/${contextId}/sync`, undefined, {
        signal: AbortSignal.timeout(HOOK_TIMEOUT_MS),
      });

      console.log(`  [synced] ${contextId} — ${(ctx.name as string) ?? "(unnamed)"}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`  [error] ${contextId} — ${message}`);
      // Don't block the commit on sync errors
    }
  }

  // Always let the commit proceed
  process.exit(0);
}

main().catch((error) => {
  console.error("[prim] Pre-commit hook error:", error);
  // Don't block the commit
  process.exit(0);
});
