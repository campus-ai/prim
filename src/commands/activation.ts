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
import { repoActiveFlag, setRepoActive } from "../lib/activation.js";
import { fetchAndCacheCollectScope } from "../lib/collect-scope.js";
import { recordHooksWired } from "../lib/commit-heartbeat.js";
import { askConfirmation, isNonInteractive } from "../lib/confirmation.js";
import {
  MANAGED_GIT_HOOK_NAMES,
  type ManagedGitHookName,
  ensureEffectiveGitHook,
} from "../lib/git-hooks.js";
import { gitToplevel } from "../lib/git.js";
import { type RepositoryBindingResult, bindRepository } from "../lib/repository-binding.js";
import { printJson } from "../output.js";
import { runGithubConnect } from "./github.js";
import { refreshOwnedGlobalHooks, stageGitHookRuntime } from "./hooks.js";

const CONNECT_PROMPT =
  "[prim] GitHub repo connection is required to enable repository-specific file attribution, Conflict Gate verification, and commit correlation. Start the GitHub App connection now?";
const GITHUB_CONNECTION_REQUIRED =
  "GitHub repo connection is required before using Primitive in this repository. It enables repository-specific file attribution, Conflict Gate verification, and commit correlation. Run `prim github connect` to complete it.";

/**
 * Wire all three managed hooks where Git runs them for this repository. This
 * is an explicit command, so it may write a tracked `.husky/*` file — once:
 * the block is version-stable and is never moved or rewritten when current.
 * post-commit capture is required; pre-commit and post-rewrite degrade.
 */
function wireRepositoryHooks(root: string): {
  paths: Partial<Record<ManagedGitHookName, string>>;
  changed: boolean;
} {
  stageGitHookRuntime();
  refreshOwnedGlobalHooks();
  const paths: Partial<Record<ManagedGitHookName, string>> = {};
  let manual = false;
  let changed = false;
  for (const hookName of MANAGED_GIT_HOOK_NAMES) {
    try {
      const result = ensureEffectiveGitHook(hookName, root, { context: "explicit" });
      if (result.outcome === "external") {
        // A shared hooks dir runs in every repository using it: enable never
        // edits one on its own.
        throw new Error(
          `Git runs this repository's ${hookName} hook from ${result.path}, outside the repository; wire it with \`prim hooks install --scope user --global-hooks-path\` or place \`prim hooks snippet ${hookName}\` yourself`,
        );
      }
      if (result.outcome === "runtime_missing") {
        process.stderr.write(
          `[prim] kept the working pre-v1 ${hookName} hook at ${result.path}; it is replaced once the hook runtime is staged\n`,
        );
      }
      paths[hookName] = result.path;
      manual ||= result.outcome === "manual";
      changed ||= result.changed;
    } catch (error) {
      if (hookName === "post-commit") throw error;
      const detail = error instanceof Error ? error.message : String(error);
      process.stderr.write(`[prim] ${hookName} hook coverage is degraded: ${detail}\n`);
    }
  }
  if (manual) {
    process.stderr.write(
      "[prim] prim.gitHooks=manual: left hook files untouched; wire them with `prim hooks snippet <hook>`\n",
    );
  }
  return { paths, changed };
}

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
      `[prim] GitHub repo connection complete for ${outcome.binding.repositoryFullName}\n`,
    );
    return outcome.binding;
  }
  if (outcome.kind === "error") {
    const detail = outcome.error instanceof Error ? outcome.error.message : String(outcome.error);
    process.stderr.write(`[prim] connect could not complete: ${detail}\n`);
  }
  return undefined;
}

function hookPathFields(paths: Partial<Record<ManagedGitHookName, string>>): {
  preCommitHook?: string;
  postCommitHook?: string;
  postRewriteHook?: string;
} {
  return {
    ...(paths["pre-commit"] ? { preCommitHook: paths["pre-commit"] } : {}),
    ...(paths["post-commit"] ? { postCommitHook: paths["post-commit"] } : {}),
    ...(paths["post-rewrite"] ? { postRewriteHook: paths["post-rewrite"] } : {}),
  };
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
    let hookPaths: Partial<Record<ManagedGitHookName, string>> = {};
    let hooksChanged = false;
    const wasActive = repoActiveFlag(root) === "true";
    if (active) {
      ({ paths: hookPaths, changed: hooksChanged } = wireRepositoryHooks(root));
      phase = "GitHub repo connection";
      binding = await bindRepository(root);
    }
    if (active && binding?.status === "unbound") {
      const connected = await maybeConnectRepository(root, globals);
      if (!connected) {
        process.stderr.write(`[prim] ${GITHUB_CONNECTION_REQUIRED}\n`);
        printJson({
          active: false,
          repo: root,
          bindingStatus: binding.status,
          repositoryFullName: binding.repositoryFullName,
          ...hookPathFields(hookPaths),
        });
        process.exitCode = 1;
        return;
      }
      binding = connected;
    }
    if (active) {
      try {
        await fetchAndCacheCollectScope(root);
      } catch {
        // The cache refresh is best effort; activation remains usable offline.
      }
    }
    phase = "local activation";
    setRepoActive(root, active);
    if (active) {
      // From here on, doctor expects every local commit to reach prim. Only
      // now: the entrypoint skips commits made before prim.active is set. A
      // re-run that changed nothing keeps the existing expectation, so it
      // cannot paper over a hook that stopped firing.
      recordHooksWired(root, { onlyIfAbsent: wasActive && !hooksChanged });
    }
    await daemonRequest("statusline_invalidate", {}, { timeoutMs: 250 });
    process.stderr.write(`[prim] prim ${active ? "enabled" : "disabled"} in ${root}\n`);
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
      ...hookPathFields(hookPaths),
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
