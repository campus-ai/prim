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
  npx --yes -p @primitive.ai/prim prim-pre-commit 2>/dev/null || true
fi
`;

export const PRIM_BLOCK_START = "# >>> prim pre-commit hook >>>";
export const PRIM_BLOCK_END = "# <<< prim pre-commit hook <<<";

const PRIM_HUSKY_BLOCK = `${PRIM_BLOCK_START}
if command -v prim-pre-commit >/dev/null 2>&1; then
  prim-pre-commit
elif [ -f "./node_modules/.bin/prim-pre-commit" ]; then
  ./node_modules/.bin/prim-pre-commit
else
  npx --yes -p @primitive.ai/prim prim-pre-commit 2>/dev/null || true
fi
${PRIM_BLOCK_END}`;

function getGitRoot(): string {
  return execSync("git rev-parse --show-toplevel", {
    encoding: "utf-8",
  }).trim();
}

export function detectHusky(gitRoot: string): boolean {
  const huskyDir = resolve(gitRoot, ".husky");
  if (!existsSync(huskyDir)) return false;

  if (existsSync(resolve(huskyDir, "_"))) return true;
  if (existsSync(resolve(huskyDir, "pre-commit"))) return true;

  const pkgPath = resolve(gitRoot, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
      const scripts = pkg.scripts ?? {};
      if (/husky/i.test(scripts.prepare ?? "") || /husky/i.test(scripts.postinstall ?? "")) {
        return true;
      }
    } catch {
      // Malformed package.json — treat as no Husky
    }
  }

  return false;
}

export function containsPrimHook(content: string): boolean {
  return content.includes("prim-pre-commit");
}

export async function askConfirmation(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}

export function installToHusky(gitRoot: string): void {
  const hookPath = resolve(gitRoot, ".husky", "pre-commit");

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (containsPrimHook(existing)) {
      console.log("Prim pre-commit hook is already installed in .husky/pre-commit.");
      return;
    }
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(hookPath, `${existing}${separator}${PRIM_HUSKY_BLOCK}\n`, {
      mode: 0o755,
    });
    console.log("Appended prim hook block to .husky/pre-commit.");
  } else {
    writeFileSync(hookPath, `#!/bin/sh\n\n${PRIM_HUSKY_BLOCK}\n`, {
      mode: 0o755,
    });
    console.log("Created .husky/pre-commit with prim hook block.");
  }
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
    .action(async () => {
      const gitRoot = getGitRoot();

      if (detectHusky(gitRoot)) {
        const confirmed = await askConfirmation(
          "Husky detected. Install prim hook into .husky/pre-commit instead of .git/hooks/pre-commit?",
        );
        if (confirmed) {
          installToHusky(gitRoot);
          return;
        }
        console.log("Falling back to .git/hooks/pre-commit install.");
      }

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
