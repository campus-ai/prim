/**
 * `prim enable` / `prim disable` — activate or mute prim in the current repo.
 *
 * The user-scope git hooks (a global core.hooksPath) fire everywhere but only
 * act where `prim.active` is true. These commands set that repo-local flag, so
 * a user installs prim once and opts each repo in (or out) with one command —
 * no per-repo hook wiring. AX: STDOUT is the JSON result, STDERR the human line.
 */
import { execFileSync } from "node:child_process";
import type { Command } from "commander";
import { setRepoActive } from "../lib/activation.js";
import { printJson } from "../output.js";

function repoRoot(): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}

function applyActivation(active: boolean): void {
  const root = repoRoot();
  if (!root) {
    process.stderr.write(
      `[prim] not a git repository — run \`prim ${active ? "enable" : "disable"}\` inside a repo\n`,
    );
    process.exit(1);
  }
  try {
    setRepoActive(process.cwd(), active);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[prim] failed to set prim.active: ${detail}\n`);
    process.exit(1);
  }
  process.stderr.write(`[prim] prim ${active ? "enabled" : "disabled"} in ${root}\n`);
  printJson({ active, repo: root });
}

export function registerActivationCommands(program: Command): void {
  program
    .command("enable")
    .description("Activate prim's hooks in this repo (git config prim.active=true)")
    .action(() => applyActivation(true));

  program
    .command("disable")
    .description("Mute prim's hooks in this repo (git config prim.active=false)")
    .action(() => applyActivation(false));
}
