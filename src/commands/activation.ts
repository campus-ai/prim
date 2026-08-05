/**
 * `prim enable` / `prim disable` — activate or mute prim in the current repo.
 *
 * The user-scope git hooks (a global core.hooksPath) fire everywhere but only
 * act where `prim.active` is true. These commands set that repo-local flag, so
 * a user installs prim once and opts each repo in (or out) with one command —
 * no per-repo hook wiring. AX: STDOUT is the JSON result, STDERR the human line.
 */
import type { Command } from "commander";
import { daemonRequest } from "../daemon/client.js";
import { setRepoActive } from "../lib/activation.js";
import { gitToplevel } from "../lib/git.js";
import { ensureEffectivePostCommitHook } from "../lib/post-commit-hook.js";
import { type RepositoryBindingResult, bindRepository } from "../lib/repository-binding.js";
import { printJson } from "../output.js";

async function applyActivation(active: boolean): Promise<void> {
  const root = gitToplevel();
  if (!root) {
    process.stderr.write(
      `[prim] not a git repository — run \`prim ${active ? "enable" : "disable"}\` inside a repo\n`,
    );
    process.exit(1);
  }
  let phase = active ? "post-commit hook coverage" : "local deactivation";
  try {
    let binding: RepositoryBindingResult | undefined;
    let postCommitHook: string | undefined;
    if (active) {
      postCommitHook = ensureEffectivePostCommitHook(root).path;
      phase = "repository binding";
      binding = await bindRepository(root);
      phase = "local activation";
    }
    setRepoActive(root, active);
    await daemonRequest("statusline_invalidate", {}, { timeoutMs: 250 });
    if (binding?.status === "pending") {
      process.stderr.write(`[prim] Prim is enabled locally in ${root}\n`);
      process.stderr.write(
        `[prim] repository ${binding.repositoryFullName} is not connected to Primitive; Moves still ingest into the team graph without repository-specific file attribution, Conflict Gate verification, or commit correlation\n`,
      );
      process.stderr.write(
        `[prim] ask an organization owner or administrator to grant Primitive's GitHub App access to this repository through Primitive's GitHub App onboarding; binding retries automatically at the next agent SessionStart\n`,
      );
    } else {
      process.stderr.write(`[prim] prim ${active ? "enabled" : "disabled"} in ${root}\n`);
    }
    printJson({
      active,
      repo: root,
      ...(binding
        ? {
            bindingStatus: binding.status,
            repositoryFullName: binding.repositoryFullName,
            ...(binding.status === "connected" ? { repoSyncId: binding.repoSyncId } : {}),
          }
        : {}),
      ...(postCommitHook ? { postCommitHook } : {}),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      active
        ? `[prim] failed to enable prim during ${phase}: ${detail}\n`
        : `[prim] failed to disable prim: ${detail}\n`,
    );
    process.exit(1);
  }
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
