/**
 * `prim enable` / `prim disable` — activate or mute prim in the current repo.
 *
 * The user-scope git hooks (a global core.hooksPath) fire everywhere but only
 * act where `prim.active` is true. These commands set that repo-local flag, so
 * a user installs prim once and opts each repo in (or out) with one command —
 * no per-repo hook wiring. AX: STDOUT is the JSON result, STDERR the human line.
 *
 * The flag is per-clone, so it cannot outlive a Claude Code cloud session,
 * which starts from a fresh clone every time. `--scope project` also records
 * (disable) or removes (enable) the repository's committed opt-out,
 * `PRIM_ACTIVE=false` in its `.claude/settings.json`, which every clone carries.
 */
import type { Command, OptionValues } from "commander";
import { daemonRequest } from "../daemon/client.js";
import {
  declaresInactive,
  markActivationExplicit,
  repoActiveFlag,
  setRepoActive,
} from "../lib/activation.js";
import { CLOUD_GITHUB_CONNECT_REMEDY, isClaudeCloudSession } from "../lib/cloud-env.js";
import { isPreparedCloudSession } from "../lib/cloud-prepared.js";
import { fetchAndCacheCollectScope } from "../lib/collect-scope.js";
import { clearHooksWired, recordHooksWired } from "../lib/commit-heartbeat.js";
import { askConfirmation, isNonInteractive } from "../lib/confirmation.js";
import { clearDemoPause } from "../lib/demo-pause.js";
import {
  MANAGED_GIT_HOOK_NAMES,
  type ManagedGitHookName,
  ensureEffectiveGitHook,
  externalHookRemedy,
} from "../lib/git-hooks.js";
import { gitToplevel, isGitIgnored } from "../lib/git.js";
import { type RepositoryBindingResult, bindRepository } from "../lib/repository-binding.js";
import { printJson } from "../output.js";
import { planProjectInactiveDeclaration } from "./claude-install.js";
import { runGithubConnect } from "./github.js";
import { refreshOwnedGlobalHooks, stageGitHookRuntime } from "./hooks.js";

const CONNECT_PROMPT =
  "[prim] GitHub repo connection is required to enable repository-specific file attribution, Conflict Gate verification, and commit correlation. Start the GitHub App connection now?";
const GITHUB_CONNECTION_REQUIRED =
  "GitHub repo connection is required before using Primitive in this repository. It enables repository-specific file attribution, Conflict Gate verification, and commit correlation.";

/** The connection is made in a browser, which a cloud VM does not have. */
function githubConnectionRequired(): string {
  return `${GITHUB_CONNECTION_REQUIRED} ${
    isClaudeCloudSession()
      ? `It cannot be completed from a Claude Code cloud session: ${CLOUD_GITHUB_CONNECT_REMEDY}.`
      : "Run `prim github connect` to complete it."
  }`;
}

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
        // A hooks dir outside the repository may run for other repositories
        // too: enable never edits one on its own.
        throw new Error(
          `Git runs this repository's ${hookName} hook from ${result.path}, outside the repository; ${externalHookRemedy(hookName, root)}`,
        );
      }
      if (result.outcome === "kept") {
        process.stderr.write(
          `[prim] kept the working pre-v1 ${hookName} hook at ${result.path}, outside the repository; to upgrade it, ${externalHookRemedy(hookName, root)}\n`,
        );
      }
      if (result.outcome === "runtime_missing") {
        process.stderr.write(
          `[prim] kept the working pre-v1 ${hookName} hook at ${result.path}; it is replaced once the hook runtime is staged\n`,
        );
      }
      paths[hookName] = result.path;
      manual ||= result.outcome === "manual";
      // Only post-commit is what doctor's evidence check judges: wiring the
      // other hooks must not reset its expectation.
      if (hookName === "post-commit") changed ||= result.changed;
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
  if (isNonInteractive(globals) || isClaudeCloudSession()) return undefined;
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

/** `--scope project` is the only scope; without it the command touches this clone alone. */
function projectScope(globals: OptionValues, active: boolean): boolean {
  if (globals.scope === undefined) return false;
  if (globals.scope === "project") return true;
  process.stderr.write(
    `[prim] invalid --scope '${String(globals.scope)}': \`prim ${active ? "enable" : "disable"}\` accepts only 'project'\n`,
  );
  process.exit(2);
}

async function applyActivation(active: boolean, globals: OptionValues = {}): Promise<void> {
  const project = projectScope(globals, active);
  const root = gitToplevel();
  if (!root) {
    process.stderr.write(
      `[prim] not a git repository — run \`prim ${active ? "enable" : "disable"}\` inside a repo\n`,
    );
    process.exit(1);
  }
  let phase = "the repository's committed opt-out";
  try {
    let binding: RepositoryBindingResult | undefined;
    let hookPaths: Partial<Record<ManagedGitHookName, string>> = {};
    let hooksChanged = false;
    const wasActive = repoActiveFlag(root) === "true";
    // First, while nothing has changed: a settings file prim cannot rewrite
    // (invalid JSON, a symbolic link, $HOME) fails the whole command.
    const declaration = project ? planProjectInactiveDeclaration(root, !active) : undefined;
    phase = active ? "post-commit hook coverage" : "local deactivation";
    if (active) {
      ({ paths: hookPaths, changed: hooksChanged } = wireRepositoryHooks(root));
      phase = "GitHub repo connection";
      binding = await bindRepository(root);
    }
    if (active && binding?.status === "unbound") {
      const connected = await maybeConnectRepository(root, globals);
      if (!connected) {
        process.stderr.write(`[prim] ${githubConnectionRequired()}\n`);
        printJson({
          active: false,
          repo: root,
          declaredInactive: declaresInactive(root),
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
    // An explicit enable/disable wins over a demo pause's saved value.
    clearDemoPause(root);
    setRepoActive(root, active);
    // The flag is now the user's own, not an implicit activation prim wrote.
    markActivationExplicit(root);
    if (declaration) {
      // Last: the clone already reflects the choice if this write fails, and
      // the error names the file that still needs it.
      phase = "the repository's committed opt-out";
      declaration.apply();
    }
    // Disabled, commits are not expected to reach prim; the next enable (or
    // SessionStart once re-activated) starts a fresh expectation.
    if (!active) clearHooksWired(root);
    if (active) {
      // From here on, doctor expects every local commit to reach prim. Only
      // now: the entrypoint skips commits made before prim.active is set. A
      // re-run that changed nothing keeps the existing expectation, so it
      // cannot paper over a hook that stopped firing.
      recordHooksWired(root, { onlyIfAbsent: wasActive && !hooksChanged });
    }
    await daemonRequest("statusline_invalidate", {}, { timeoutMs: 250 });
    process.stderr.write(`[prim] prim ${active ? "enabled" : "disabled"} in ${root}\n`);
    const declaredInactive = declaresInactive(root);
    // An opt-out git ignores never reaches another clone: `git add` skips it
    // without `-f`, and "commit it" alone would leave the user with nothing.
    const ignored = Boolean(project && !active && isGitIgnored(root, ".claude/settings.json"));
    if (declaration?.changed)
      process.stderr.write(
        active
          ? `[prim] removed this repository's opt-out from ${declaration.path}; commit the change so new clones and Claude Code cloud sessions follow it\n`
          : `[prim] recorded this repository's opt-out (PRIM_ACTIVE=false) in ${declaration.path}; commit it so prim stays off in every clone and every Claude Code cloud session, until someone runs \`prim enable\` there\n`,
      );
    if (ignored)
      process.stderr.write(
        "[prim] this repository's .gitignore covers .claude/settings.json, so a plain `git add` skips it: stage it with `git add -f .claude/settings.json`, or the opt-out stays in this clone only\n",
      );
    else if (active && declaredInactive)
      process.stderr.write(
        "[prim] this repository commits an opt-out (PRIM_ACTIVE=false in .claude/settings.json): enabled for this clone only. `prim enable --scope project` removes the opt-out\n",
      );
    else if (!active && !declaredInactive && isPreparedCloudSession())
      process.stderr.write(
        "[prim] this lasts for this session's clone only: the next Claude Code cloud session starts from a fresh one. To keep prim off in this repository, run `prim disable --scope project` and commit .claude/settings.json\n",
      );
    printJson({
      active,
      repo: root,
      declaredInactive,
      ...(declaration?.changed ? { settingsPath: declaration.path } : {}),
      ...(ignored ? { settingsIgnored: true } : {}),
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
    .option(
      "--scope <scope>",
      "project: also remove the repository's committed opt-out from .claude/settings.json",
    )
    .action((_opts: unknown, command: Command) => applyActivation(true, command.optsWithGlobals()));

  program
    .command("disable")
    .description("Mute prim's hooks in this repo (git config prim.active=false)")
    .option(
      "--scope <scope>",
      "project: also record the opt-out in .claude/settings.json to commit, so it holds in every clone and Claude Code cloud session",
    )
    .action((_opts: unknown, command: Command) =>
      applyActivation(false, command.optsWithGlobals()),
    );
}
