/**
 * `prim enable` / `prim disable` — activate or mute prim in the current repo.
 *
 * The user-scope git hooks (a global core.hooksPath) fire everywhere but only
 * act where `prim.active` is true. These commands set that repo-local flag, so
 * a user installs prim once and opts each repo in (or out) with one command —
 * no per-repo hook wiring. AX: STDOUT is the JSON result, STDERR the human line.
 */
import type { Command, OptionValues } from "commander";
import { daemonRequest } from "../daemon/client.js";
import { setRepoActive } from "../lib/activation.js";
import { askConfirmation, isNonInteractive } from "../lib/confirmation.js";
import { gitToplevel } from "../lib/git.js";
import {
  ensureEffectivePostCommitHook,
  ensureEffectivePostRewriteHook,
} from "../lib/post-commit-hook.js";
import { type RepositoryBindingResult, bindRepository } from "../lib/repository-binding.js";
import { printJson } from "../output.js";
import { runGithubConnect } from "./github.js";

const CONNECT_PROMPT = "[prim] Connect this repository to Primitive via the GitHub App now?";

/**
 * When a repo is enabled but unbound, offer to connect it now, reusing the
 * `github connect` flow. Honors the standard ladder: `--yes` auto-launches the
 * browser bind, a TTY gets a [y/N] prompt, and non-interactive / non-TTY skips
 * so the caller falls back to the passive "ask an org owner…" message. Never
 * throws — a connect failure resolves to `undefined` (stay unbound, non-fatal).
 */
async function maybeConnectRepository(
  root: string,
  globals: OptionValues,
): Promise<RepositoryBindingResult | undefined> {
  if (isNonInteractive(globals)) return undefined;
  const approved = Boolean(globals.yes) || (await askConfirmation(CONNECT_PROMPT, process.stderr));
  if (!approved) return undefined;
  const outcome = await runGithubConnect(undefined, { root, browser: true });
  if (outcome.kind === "connected") {
    process.stderr.write(
      `[prim] repository binding connected for GitHub origin ${outcome.binding.repositoryFullName}\n`,
    );
    return outcome.binding;
  }
  if (outcome.kind === "error") {
    const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    process.stderr.write(`[prim] connect could not complete: ${detail}\n`);
  }
  return undefined;
}

async function applyActivation(active: boolean, globals: OptionValues = {}): Promise<void> {
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
    let postRewriteHook: string | undefined;
    if (active) {
      postCommitHook = ensureEffectivePostCommitHook(root).path;
      try {
        postRewriteHook = ensureEffectivePostRewriteHook(root).path;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        process.stderr.write(`[prim] post-rewrite hook coverage is degraded: ${detail}\n`);
      }
      phase = "repository binding";
      binding = await bindRepository(root);
      phase = "local activation";
    }
    setRepoActive(root, active);
    if (active && binding?.status === "unbound") {
      const connected = await maybeConnectRepository(root, globals);
      if (connected) binding = connected;
    }
    await daemonRequest("statusline_invalidate", {}, { timeoutMs: 250 });
    if (binding?.status === "unbound") {
      process.stderr.write(`[prim] Prim is enabled locally in ${root}\n`);
      process.stderr.write(
        "[prim] repository is not connected to Primitive; Moves still ingest into the team graph without repository-specific file attribution, Conflict Gate verification, or commit correlation\n",
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
      ...(postRewriteHook ? { postRewriteHook } : {}),
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
    .action((_opts: unknown, command: Command) => applyActivation(true, command.optsWithGlobals()));

  program
    .command("disable")
    .description("Mute prim's hooks in this repo (git config prim.active=false)")
    .action((_opts: unknown, command: Command) =>
      applyActivation(false, command.optsWithGlobals()),
    );
}
