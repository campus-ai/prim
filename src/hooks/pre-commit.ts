#!/usr/bin/env node
/**
 * Pre-commit hook for the decision graph.
 *
 * When a developer commits code, this hook checks the staged files against the
 * live decision graph and surfaces any active decisions that reference them —
 * warn-only, it never blocks the commit.
 *
 * Install: prim hooks install
 */
import { execSync } from "node:child_process";
import {
  type DecisionsCheckResult,
  checkAffectedDecisions,
  formatDecisionsWarning,
} from "./decisions-check.js";

function getStagedFiles(): string[] {
  const output = execSync("git diff --cached --name-only", {
    encoding: "utf-8",
  });
  return output
    .trim()
    .split("\n")
    .filter((f) => f.length > 0);
}

async function runDecisionsCheck(): Promise<DecisionsCheckResult> {
  const stagedFiles = getStagedFiles();
  if (stagedFiles.length === 0) {
    return { decisions: [], truncated: false };
  }
  return checkAffectedDecisions(stagedFiles);
}

async function main() {
  const decisionsResult = await runDecisionsCheck();
  const warning = formatDecisionsWarning(decisionsResult);
  if (warning) {
    console.error(warning);
  }
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
