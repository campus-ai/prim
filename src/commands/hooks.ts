/**
 * Hook management commands for the prim CLI.
 *
 * prim hooks install   — Install git pre-commit hook
 * prim hooks uninstall — Remove git pre-commit hook
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";

const HOOK_SCRIPT = `#!/bin/sh
# prim pre-commit hook — auto-syncs affected specs on commit
# Installed by: prim hooks install

# Find the nearest node_modules/.bin with prim, or use npx
if command -v prim-pre-commit >/dev/null 2>&1; then
  prim-pre-commit
elif [ -f "./node_modules/.bin/prim-pre-commit" ]; then
  ./node_modules/.bin/prim-pre-commit
else
  npx --yes @primitive/cli pre-commit-hook 2>/dev/null || true
fi
`;

function getGitRoot(): string {
  return execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
  }).trim();
}

export function containsPrimHook(content: string): boolean {
  return content.includes("prim-pre-commit");
}

export function installToDotGit(gitRoot: string): void {
  const hooksDir = resolve(gitRoot, ".git", "hooks");
  const hookPath = resolve(hooksDir, "pre-commit");

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (containsPrimHook(existing)) {
      console.log("Prim pre-commit hook is already installed at .git/hooks/pre-commit.");
      return;
    }
    console.log(`A pre-commit hook already exists at ${hookPath}.`);
    console.log("To replace it, run: prim hooks uninstall && prim hooks install");
    return;
  }

  writeFileSync(hookPath, HOOK_SCRIPT, { mode: 0o755 });
  console.log(`Installed pre-commit hook at ${hookPath}`);
}

export function registerHooksCommands(program: Command) {
  const hooks = program.command("hooks").description("Manage git hooks");

  hooks
    .command("install")
    .description("Install the prim pre-commit hook")
    .action(() => {
      const gitRoot = getGitRoot();
      installToDotGit(gitRoot);
    });

  hooks
    .command("uninstall")
    .description("Remove the prim pre-commit hook")
    .action(() => {
      const gitRoot = getGitRoot();
      const hookPath = resolve(gitRoot, ".git", "hooks", "pre-commit");

      if (!existsSync(hookPath)) {
        console.log("No pre-commit hook found.");
        return;
      }

      unlinkSync(hookPath);
      console.log(`Removed pre-commit hook at ${hookPath}`);
    });
}
