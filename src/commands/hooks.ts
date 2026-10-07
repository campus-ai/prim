/**
 * Hook management commands for the prim CLI.
 *
 * prim hooks install   — Wire prim into the pre-commit, post-commit, and post-rewrite hooks
 * prim hooks snippet   — Print the block that wires one hook, to place by hand
 * prim hooks uninstall — Remove prim's blocks (and any hook file prim created)
 *
 * Every hook file receives the same frozen v1 block (lib/git-hook-contract.ts),
 * inserted right after the shebang and never rewritten once current. It execs
 * prim's staged entrypoint, so no hook file ever names a version or a machine
 * path. `git config prim.gitHooks manual` stops prim writing any hook file.
 *
 * Two scopes:
 *   project (default) — writes into the hooks Git runs for this repo (.git/hooks,
 *     .husky, or a configured core.hooksPath).
 *   user (--scope user) — installs ONCE at user level via a global
 *     `core.hooksPath`. The hooks fire in every repo but only ACT where prim is
 *     activated (`prim enable` / `git config prim.active`), so commit capture is
 *     opt-in per repo with no per-repo install — see lib/activation.ts.
 *
 * User-scope caveats (git's own precedence rules):
 *   - A repo with its OWN local `core.hooksPath` (e.g. husky v9 sets
 *     `.husky/_`) overrides the global one, so prim's global hook won't fire
 *     there — run `prim enable` in those repos.
 *   - If a global `core.hooksPath` already points elsewhere, prim adds its
 *     block into that dir instead of hijacking the pointer.
 *   - A system-level `core.hooksPath` is not overridden without --force.
 *   - Requires git ≥ 2.9.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { Argument, type Command, Option } from "commander";
import { askConfirmation, isNonInteractive } from "../lib/confirmation.js";
import { isLegacyOwnedGlobalHook } from "../lib/git-hook-legacy.js";
import {
  type EnsureHookResult,
  MANAGED_GIT_HOOK_NAMES,
  type ManagedGitHookName,
  ensureEffectiveGitHook,
  ensureGitHookAtPath,
  externalHookRemedy,
  gitHooksMode,
  isOwnedStandalonePreCommit,
  managedHookBlock,
  projectGitHookTarget,
  projectHooksDir,
  resolveEffectiveGitHook,
  uninstallGitHookAtPath,
  uninstallProjectGitHook,
} from "../lib/git-hooks.js";
import { gitToplevel } from "../lib/git.js";
import {
  hookRuntimePaths,
  inspectGitHookEntrypoint,
  stageHookRuntime,
} from "../lib/hook-runtime.js";
import { primConfigDirectory } from "../lib/paths.js";

type HookSpec = { hookName: ManagedGitHookName; binName: string };

const PRE_COMMIT: HookSpec = { hookName: "pre-commit", binName: "prim-pre-commit" };
const POST_COMMIT: HookSpec = { hookName: "post-commit", binName: "prim-post-commit" };
const POST_REWRITE: HookSpec = { hookName: "post-rewrite", binName: "prim-post-rewrite" };
// Pre-commit first: install order is asserted by hooks.spec.ts (calls[0]).
const HOOKS: HookSpec[] = [PRE_COMMIT, POST_COMMIT, POST_REWRITE];
const GIT_TIMEOUT_MS = 1_000;

function blockMarkers(spec: HookSpec): { start: string; end: string } {
  return {
    start: `# >>> prim ${spec.hookName} hook >>>`,
    end: `# <<< prim ${spec.hookName} hook <<<`,
  };
}

// Back-compat exports: the pre-commit markers, asserted against in tests.
export const PRIM_BLOCK_START = blockMarkers(PRE_COMMIT).start;
export const PRIM_BLOCK_END = blockMarkers(PRE_COMMIT).end;

// A sentinel line every prim-MANAGED .git/hooks script carried, so the global
// hook's chain-back can recognize (and skip) a prim hook without matching the
// bare bin name — which a user's own hook might merely mention in a comment.
const PRIM_MANAGED_MARK = "prim-managed-hook";

// Provenance sentinel earlier releases wrote into files they created in a
// foreign hooksPath dir. Its presence without markers makes ownership ambiguous.
const PRIM_CREATED_MARK = "prim-created-hook";

/**
 * Stage the immutable hook runtime and the frozen entrypoint every managed
 * block execs. A failure leaves wired blocks inert (doctor reports
 * `entrypoint_missing`), so it warns rather than aborting the wiring.
 */
export function stageGitHookRuntime(): boolean {
  try {
    stageHookRuntime();
    return true;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[prim] git hooks stay inert until the hook runtime is staged: ${detail}`);
    return false;
  }
}

function getGitRoot(): string {
  const root = gitToplevel();
  if (root === null) {
    throw new Error("not a git repository (run inside a repo, or use --scope user)");
  }
  return root;
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

// ---------------------------------------------------------------------------
// User scope — a global core.hooksPath that captures commits in every repo.
// ---------------------------------------------------------------------------

// Prim owns this dir (distinct from git's own configuration directory).
export const PRIM_GIT_HOOKS_DIR = join(primConfigDirectory(), "git-hooks");

// git stores core.hooksPath verbatim (a leading ~ is expanded by git at runtime,
// not by us), so normalize before any filesystem use or equality check.
function expandTilde(p: string): string {
  return p.startsWith("~/") ? join(homedir(), p.slice(2)) : p;
}

function isOurHooksDir(value: string): boolean {
  return value !== "" && expandTilde(value) === PRIM_GIT_HOOKS_DIR;
}

// Read core.hooksPath at a specific level only. NEVER a bare `--get`: inside a
// husky repo that would read the repo-local `.husky/_` and we'd corrupt it.
function gitConfigGet(level: "--global" | "--system"): string {
  try {
    return execFileSync("git", ["config", level, "--get", "core.hooksPath"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    // Unset (exit 1) or no such config file — treat as empty.
    return "";
  }
}

// Client-side hooks prim does NOT manage but which git's core.hooksPath would
// otherwise shadow: setting a global core.hooksPath REPLACES .git/hooks for
// every hook type, so without a stub for these, a repo's own commit-msg /
// pre-push / git-lfs / pre-commit-framework hooks silently stop firing. We
// write a pass-through stub for each so they still reach the repo's real hook.
// (pre-commit / post-commit / post-rewrite are prim's own — see HOOKS.)
const PASSTHROUGH_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-auto-gc",
  "push-to-checkout",
  "sendemail-validate",
  "reference-transaction",
  "post-index-change",
  // (fsmonitor-watchman is intentionally omitted — it's driven by core.fsmonitor
  //  with a query protocol, not a lifecycle event, so a bare exec stub is wrong.)
] as const;

// A standalone global hook: run prim's block, then chain to the repo's own hook
// so a global core.hooksPath doesn't silently disable it. The block itself
// gates on prim.active (in the entrypoint), so inactive repos are unaffected.
// --git-common-dir is NOT core.hooksPath-aware, so the chained path is always
// the repo's real .git/hooks — never this script (no recursion). --git-path
// hooks/… IS core.hooksPath-aware and would self-reference, so it must not be
// used. The chain guard matches the legacy managed-hook sentinel or the managed
// block marker (not the bare bin name, which a user's own hook might mention)
// to avoid double-invoking prim across project-to-user migrations.
function globalHookScript(spec: HookSpec): string {
  // pre-commit may legitimately block the commit — propagate the repo hook's
  // exit; post-commit/post-rewrite run after mutation and cannot block it.
  const preCommit = spec.hookName === PRE_COMMIT.hookName;
  const chainExit = preCommit ? "|| exit $?" : "|| true";
  // A repo pre-commit is never skipped: it may enforce checks of its own.
  const managedRepoGuard = preCommit
    ? ""
    : ` && ! grep -Fq '${blockMarkers(spec).start.slice(0, -3)}'">>>" "$repo_hook" 2>/dev/null`;
  return `#!/bin/sh
${managedHookBlock(spec.hookName)}
# prim global ${spec.hookName} hook (core.hooksPath) — managed by prim; do not edit.
# Install/uninstall: prim hooks install|uninstall --scope user
# Runs prim only where activated — 'prim enable' (this repo) or
# 'git config --global prim.active true' (every repo). Chains to the repo's own
# hook regardless, so inactive repos are unaffected.
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
repo_hook="$common_dir/hooks/${spec.hookName}"
if [ -x "$repo_hook" ] && ! grep -q '${PRIM_MANAGED_MARK}' "$repo_hook" 2>/dev/null${managedRepoGuard}; then
  "$repo_hook" "$@" ${chainExit}
fi
exit 0
`;
}

// A pass-through stub for a hook type prim does not manage: forward to the
// repo's real hook (exec, so its exit code propagates) or exit 0 if none.
function passThroughScript(hookName: string): string {
  return `#!/bin/sh
# prim pass-through hook (core.hooksPath) — managed by prim; do not edit.
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
repo_hook="$common_dir/hooks/${hookName}"
[ -x "$repo_hook" ] && exec "$repo_hook" "$@"
exit 0
`;
}

function expectedOwnedHookContent(hookName: string): string | null {
  const managed = HOOKS.find((spec) => spec.hookName === hookName);
  if (managed) return globalHookScript(managed);
  if ((PASSTHROUGH_HOOKS as readonly string[]).includes(hookName)) {
    return passThroughScript(hookName);
  }
  return null;
}

// An owned global hook is either the current script or one an earlier release
// wrote, recognized exactly (modulo its pinned version) so it stays removable.
function isExpectedOwnedGlobalHook(content: string, hookName: string): boolean {
  const expected = expectedOwnedHookContent(hookName);
  if (expected === null) return false;
  if (content === expected) return true;
  const managed = HOOKS.find((spec) => spec.hookName === hookName);
  return managed !== undefined && isLegacyOwnedGlobalHook(content, managed.hookName);
}

function lstatIfPresent(path: string): ReturnType<typeof lstatSync> | undefined {
  try {
    return lstatSync(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return undefined;
    throw error;
  }
}

function assertOwnedHooksDirectorySafeToRemove(): string[] {
  const directory = lstatIfPresent(PRIM_GIT_HOOKS_DIR);
  if (!directory) return [];
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error(
      `refusing to remove global hooks: ${PRIM_GIT_HOOKS_DIR} is not a Prim-owned directory`,
    );
  }
  const entries = readdirSync(PRIM_GIT_HOOKS_DIR);
  for (const name of entries) {
    if (expectedOwnedHookContent(name) === null) {
      throw new Error(
        `refusing to remove global hooks: unexpected entry ${resolve(PRIM_GIT_HOOKS_DIR, name)}`,
      );
    }
    const path = resolve(PRIM_GIT_HOOKS_DIR, name);
    const stat = lstatSync(path);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      !isExpectedOwnedGlobalHook(readFileSync(path, "utf-8"), name)
    ) {
      throw new Error(`refusing to remove global hooks: ${path} is not an exact Prim-owned hook`);
    }
  }
  return entries;
}

/**
 * Rewrite prim's owned global hooks. Refuses while the hook runtime is not
 * staged: the scripts it would write do nothing until it is, and replacing a
 * working pre-v1 script would silently stop capture in every repository.
 */
function writeOwnHooks(): boolean {
  if (inspectGitHookEntrypoint() !== "ready") {
    console.error(
      `[prim] did not write prim's global hooks in ${PRIM_GIT_HOOKS_DIR}: the hook runtime they run is not staged yet. Run \`prim setup\` (or an agent install such as \`prim claude install\`) first, then retry.`,
    );
    return false;
  }
  if (!existsSync(PRIM_GIT_HOOKS_DIR)) {
    mkdirSync(PRIM_GIT_HOOKS_DIR, { recursive: true });
  }
  // This directory is wholly Prim-owned, so every managed hook — post-commit
  // included — is rewritten to its canonical standalone script on each install.
  // A plain overwrite is self-healing: unlike a marker block-merge it cannot
  // fail on a pre-existing hook whose Prim markers were left malformed or
  // duplicated by an interrupted or legacy install.
  for (const spec of HOOKS) {
    writeFileSync(resolve(PRIM_GIT_HOOKS_DIR, spec.hookName), globalHookScript(spec), {
      mode: 0o755,
    });
  }
  for (const name of PASSTHROUGH_HOOKS) {
    writeFileSync(resolve(PRIM_GIT_HOOKS_DIR, name), passThroughScript(name), { mode: 0o755 });
  }
  return true;
}

/** Refresh Prim's wholly-owned global hooks without changing Git config. */
export function refreshOwnedGlobalHooks(): boolean {
  if (!isOurHooksDir(gitConfigGet("--global"))) return false;
  return writeOwnHooks();
}

// Add prim's block into a hook file in a foreign global core.hooksPath dir we
// don't own. Idempotent. No chain tail: git already runs only this dir, so the
// file's other contents are the repo owner's, left in place. The entrypoint
// gates on prim.active, so user scope stays opt-in even here.
function appendPrimBlock(hookPath: string, spec: HookSpec): void {
  ensureGitHookAtPath(spec.hookName, hookPath);
}

function stripPrimBlock(hookPath: string, spec: HookSpec): void {
  uninstallGitHookAtPath(spec.hookName, hookPath);
}

type PreCommitRemovalPlan = {
  path: string;
  action: "missing" | "remove-owned-file" | "strip-block" | "leave-foreign";
};

function planPreCommitRemoval(
  hookPath: string,
  options: { allowOwnedStandalone: boolean },
): PreCommitRemovalPlan {
  if (!existsSync(hookPath)) return { path: hookPath, action: "missing" };
  const existing = readFileSync(hookPath, "utf-8");
  if (options.allowOwnedStandalone && isOwnedStandalonePreCommit(existing)) {
    return { path: hookPath, action: "remove-owned-file" };
  }
  const { start, end } = blockMarkers(PRE_COMMIT);
  if (existing.includes(start) || existing.includes(end)) {
    return { path: hookPath, action: "strip-block" };
  }
  if (
    existing.includes(PRE_COMMIT.binName) ||
    existing.includes(PRIM_MANAGED_MARK) ||
    existing.includes(PRIM_CREATED_MARK)
  ) {
    throw new Error(
      `refusing to remove ambiguous pre-commit hook at ${hookPath}; Prim ownership could not be proven`,
    );
  }
  return { path: hookPath, action: "leave-foreign" };
}

function applyPreCommitRemoval(plan: PreCommitRemovalPlan, husky: boolean): void {
  if (plan.action === "missing") return;
  if (plan.action === "leave-foreign") {
    console.log(`Left pre-commit hook at ${plan.path} untouched (not a Prim hook).`);
    return;
  }
  const result = uninstallGitHookAtPath(PRE_COMMIT.hookName, plan.path, { husky });
  console.log(
    result.removedFile
      ? `Removed pre-commit hook at ${plan.path}`
      : `Removed the Prim pre-commit block from ${plan.path}.`,
  );
}

export function uninstallProjectHooks(gitRoot: string): void {
  // Every place a project install may have put pre-commit: the common
  // .git/hooks, .husky, and wherever a repo-local core.hooksPath points.
  // Preflight them all before mutating any, so a malformed or ambiguous hook
  // in one cannot leave a partial uninstall in another.
  const configured = projectGitHookTarget(PRE_COMMIT.hookName, gitRoot);
  const destinations = [
    {
      path: resolve(projectHooksDir(gitRoot), PRE_COMMIT.hookName),
      husky: false,
      allowOwnedStandalone: true,
    },
    {
      path: resolve(gitRoot, ".husky", PRE_COMMIT.hookName),
      husky: true,
      allowOwnedStandalone: false,
    },
    // A shared hooks dir is never stripped on this repository's behalf.
    ...(configured.location === "external"
      ? []
      : [
          {
            path: configured.hookPath,
            husky: configured.kind === "husky_v9",
            allowOwnedStandalone: false,
          },
        ]),
  ].filter(
    (destination, index, all) =>
      all.findIndex((other) => other.path === destination.path) === index,
  );
  const plans = destinations.map(({ path, husky, allowOwnedStandalone }) => ({
    plan: planPreCommitRemoval(path, { allowOwnedStandalone }),
    husky,
  }));
  for (const { plan, husky } of plans) applyPreCommitRemoval(plan, husky);

  for (const spec of [POST_COMMIT, POST_REWRITE]) {
    const result = uninstallProjectGitHook(spec.hookName, gitRoot);
    if (result.skipped === "external") {
      console.log(
        `Left ${result.path} alone: it is outside this repository, and other repositories may run it.`,
      );
    } else if (!result.changed) {
      console.log(`No Prim ${spec.hookName} block found at ${result.path}.`);
    } else if (result.removedFile) {
      console.log(`Removed Prim-created ${spec.hookName} hook at ${result.path}.`);
    } else {
      console.log(`Removed the Prim ${spec.hookName} block from ${result.path}.`);
    }
  }
}

// Install prim's git hooks at USER scope via a global core.hooksPath. Coexists
// with an existing global hooksPath (adds into it) rather than clobbering.
// Returns whether hooks were installed — false when it declines (system
// hooksPath present without --force, or prim.gitHooks=manual) so callers can
// report an honest skip.
export function installGlobalHooks(opts: { force?: boolean } = {}): boolean {
  stageGitHookRuntime();
  const global = gitConfigGet("--global");
  if (gitHooksMode({ global: true }) === "manual") {
    console.error(
      isOurHooksDir(global)
        ? `[prim] prim.gitHooks=manual: left hook files alone, but prim's global hooks in ${PRIM_GIT_HOOKS_DIR} are still active. Run \`prim hooks uninstall --scope user\` to stop them.`
        : "[prim] prim.gitHooks=manual: left hook files and core.hooksPath untouched. Wire prim yourself with `prim hooks snippet <hook>`.",
    );
    return false;
  }
  if (global === "") {
    const system = gitConfigGet("--system");
    if (system !== "" && !isOurHooksDir(system)) {
      if (!opts.force) {
        console.error(
          `[prim] system core.hooksPath is set to ${system}; a --global set would override it, and prim chains only to .git/hooks (not a system dir), so those hooks would stop firing. Skipping — re-run with --force to override, or run per-repo \`prim hooks install\`.`,
        );
        return false;
      }
      console.error(
        `[prim] --force: overriding system core.hooksPath ${system}; its hooks will no longer fire (prim chains only to .git/hooks).`,
      );
    }
    if (!writeOwnHooks()) return false;
    execFileSync("git", ["config", "--global", "core.hooksPath", PRIM_GIT_HOOKS_DIR], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    console.log(
      `Installed prim global git hooks; set core.hooksPath to ${PRIM_GIT_HOOKS_DIR}. Repos are opt-in: run \`prim enable\` in each repo to capture, or \`git config --global prim.active true\` for all.`,
    );
    return true;
  }
  if (isOurHooksDir(global)) {
    if (writeOwnHooks()) {
      console.log(
        `Prim global git hooks already active (${PRIM_GIT_HOOKS_DIR}); refreshed scripts.`,
      );
    }
    return true;
  }
  // Coexist: a global core.hooksPath already points elsewhere — add prim's
  // block into that dir and leave the pointer untouched.
  // Blocks written without a staged runtime do nothing: refuse rather than
  // report hooks that cannot capture.
  if (inspectGitHookEntrypoint() !== "ready") {
    console.error(
      `[prim] did not add prim's hooks to ${global}: the hook runtime they run is not staged yet. Run \`prim setup\` (or an agent install such as \`prim claude install\`) first, then retry.`,
    );
    return false;
  }
  const dir = expandTilde(global);
  for (const spec of HOOKS) appendPrimBlock(resolve(dir, spec.hookName), spec);
  console.log(`Added prim hooks into existing core.hooksPath dir ${global} (pointer unchanged).`);
  return true;
}

export function uninstallGlobalHooks(): void {
  const global = gitConfigGet("--global");
  if (isOurHooksDir(global)) {
    const entries = assertOwnedHooksDirectorySafeToRemove();
    for (const name of entries) unlinkSync(resolve(PRIM_GIT_HOOKS_DIR, name));
    // Only unset because the value is still ours (avoids the exit-5-on-absent
    // and multivar footguns of a blind --unset).
    execFileSync("git", ["config", "--global", "--unset", "core.hooksPath"], {
      stdio: ["ignore", "ignore", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
    console.log("Removed prim global git hooks and unset core.hooksPath.");
    return;
  }
  if (global !== "") {
    const dir = expandTilde(global);
    for (const spec of HOOKS) {
      stripPrimBlock(resolve(dir, spec.hookName), spec);
    }
    console.log(`Removed the prim block from ${global} (left the dir and core.hooksPath intact).`);
    return;
  }
  console.log("No prim global git hooks found.");
}

type InstallTarget = "effective" | "husky" | "git-hooks";

function reportInstall(result: EnsureHookResult, gitRoot: string): void {
  const { hookName, path } = result;
  switch (result.outcome) {
    case "created":
      console.log(`Installed prim ${hookName} hook at ${path}.`);
      return;
    case "updated":
      console.log(`Updated prim ${hookName} hook at ${path}.`);
      return;
    case "unchanged":
      console.log(`Already current: prim ${hookName} hook at ${path}.`);
      return;
    case "external":
      console.error(
        `[prim] ${hookName}: Git runs this repository's hooks from ${path}, outside the repository, so prim left it alone. ${externalHookRemedy(hookName, gitRoot)}.`,
      );
      return;
    case "kept":
      console.error(
        `[prim] ${hookName}: kept the working pre-v1 prim block at ${path}, outside the repository; it still captures. To upgrade it, ${externalHookRemedy(hookName, gitRoot)}.`,
      );
      return;
    case "runtime_missing":
      console.error(
        `[prim] ${hookName}: kept the existing prim hook at ${path}; it still works, and its replacement would stay inert until the hook runtime is staged.`,
      );
      return;
    default:
      console.error(`[prim] ${hookName}: left ${path} as it was (${result.outcome}).`);
  }
}

// Install every prim git hook (pre-commit + post-commit + post-rewrite) to the
// chosen destination, pre-commit first so its write is calls[0] in tests.
// post-commit capture is required; the other two degrade with a warning.
function installHooks(gitRoot: string, target: InstallTarget): void {
  if (target !== "effective") {
    const effectiveDir = resolveEffectiveGitHook(PRE_COMMIT.hookName, gitRoot).hooksDir;
    const chosenDir = target === "husky" ? resolve(gitRoot, ".husky") : projectHooksDir(gitRoot);
    if (resolve(effectiveDir) !== chosenDir && resolve(effectiveDir, "..") !== chosenDir) {
      console.error(
        `[prim] note: Git runs this repository's hooks from ${effectiveDir}; hooks in ${chosenDir} will not fire unless that directory chains to them.`,
      );
    }
  }
  for (const spec of HOOKS) {
    try {
      const result =
        target === "effective"
          ? ensureEffectiveGitHook(spec.hookName, gitRoot, { context: "explicit" })
          : ensureGitHookAtPath(
              spec.hookName,
              target === "husky"
                ? resolve(gitRoot, ".husky", spec.hookName)
                : resolve(projectHooksDir(gitRoot), spec.hookName),
              { husky: target === "husky" },
            );
      reportInstall(result, gitRoot);
      if (spec === POST_COMMIT && result.outcome === "external") process.exitCode = 1;
    } catch (error) {
      if (spec === POST_COMMIT) throw error;
      const detail = error instanceof Error ? error.message : String(error);
      console.error(
        `[prim] ${spec.hookName} hook coverage is degraded: ${detail}. To wire it by hand, run \`prim hooks snippet ${spec.hookName}\`.`,
      );
    }
  }
}

function printManualNote(gitRoot: string): void {
  console.error(
    `[prim] prim.gitHooks=manual: left the hook files in ${gitRoot} untouched. Wire each hook with \`prim hooks snippet <hook>\`; \`prim doctor\` reports what it finds.`,
  );
}

export function registerHooksCommands(program: Command) {
  const hooks = program.command("hooks").description("Manage git hooks");

  hooks
    .command("install")
    .description(
      "Install the prim git hooks — pre-commit + post-commit + post-rewrite (auto-detects Husky; use --target to override)",
    )
    .addOption(
      new Option("--target <where>", "install destination; bypasses Husky detection").choices([
        "husky",
        "git-hooks",
      ]),
    )
    .addOption(
      new Option(
        "--scope <scope>",
        "project (default, this repo) or user (a global core.hooksPath capturing every repo)",
      ).choices(["project", "user"]),
    )
    .option("--force", "with --scope user, override a system-level core.hooksPath")
    .action(
      async (
        opts: { target?: "husky" | "git-hooks"; scope?: "project" | "user"; force?: boolean },
        command: Command,
      ) => {
        // User scope is repo-agnostic — a global core.hooksPath, no gitRoot and
        // no --target (husky/git-hooks are per-repo concepts). A declined install
        // (system hooksPath without --force) is a legitimate config, not a
        // failure: installGlobalHooks already prints a loud STDERR warning with
        // the remedy, so exit 0 and let `prim setup` complete rather than report
        // an incomplete run for a benign case.
        if (opts.scope === "user") {
          installGlobalHooks({ force: opts.force });
          return;
        }
        const globals = command.optsWithGlobals();
        const nonInteractive = isNonInteractive(globals);
        const gitRoot = getGitRoot();
        if (gitHooksMode({ cwd: gitRoot }) === "manual") {
          printManualNote(gitRoot);
          return;
        }
        stageGitHookRuntime();

        if (opts.target === "husky") return installHooks(gitRoot, "husky");
        if (opts.target === "git-hooks") return installHooks(gitRoot, "git-hooks");

        // A configured core.hooksPath (Husky's `.husky/_`, a global dir, …) is
        // where Git runs hooks; only an unconfigured Husky repo needs a choice.
        const effectiveDir = resolveEffectiveGitHook(PRE_COMMIT.hookName, gitRoot).hooksDir;
        if (resolve(effectiveDir) === projectHooksDir(gitRoot) && detectHusky(gitRoot)) {
          if (globals.yes) return installHooks(gitRoot, "husky");
          if (nonInteractive) {
            throw new Error(
              "--non-interactive set, refusing to prompt for Husky-hook installation. Pass --yes to confirm or --target=git-hooks to choose.",
            );
          }
          if (!process.stdin.isTTY) {
            console.error(
              "Note: Husky detected but stdin is not a TTY — falling back to .git/hooks. Pass --yes for Husky or --non-interactive to fail fast.",
            );
          } else if (
            await askConfirmation(
              "Husky detected. Install prim hooks into .husky/ instead of .git/hooks/?",
            )
          ) {
            return installHooks(gitRoot, "husky");
          } else {
            console.log("Falling back to .git/hooks install.");
          }
          return installHooks(gitRoot, "git-hooks");
        }

        installHooks(gitRoot, "effective");
      },
    );

  hooks
    .command("snippet")
    .description("Print the block that wires one prim git hook (STDOUT), to place by hand")
    .addArgument(new Argument("<hook>", "git hook").choices(MANAGED_GIT_HOOK_NAMES))
    .action((hook: ManagedGitHookName) => {
      process.stdout.write(`${managedHookBlock(hook)}\n`);
      let entrypoint = "<prim config>/prim-git-hook-v1";
      try {
        entrypoint = hookRuntimePaths().gitHookEntrypoint;
      } catch {
        // An unusable config root only affects this hint.
      }
      process.stderr.write(
        `[prim] Place this block right after the shebang of your ${hook} hook (in a Husky v8 hook, right after the husky.sh line), before any exit or exec. It runs prim's ${hook} step where prim is installed and enabled, and does nothing elsewhere.${
          hook === "post-rewrite"
            ? " It re-arms stdin, so commands after it still read Git's rewrite pairs."
            : ""
        }\n[prim] From a hook manager, run \`${entrypoint} ${hook} "$@"\`${
          hook === "post-rewrite" ? " with Git's stdin" : ""
        } instead. Set \`git config prim.gitHooks manual\` so prim leaves your hook files alone.\n`,
      );
    });

  hooks
    .command("uninstall")
    .description(
      "Remove the prim git hooks (.git/hooks, or the global core.hooksPath with --scope user)",
    )
    .addOption(
      new Option(
        "--scope <scope>",
        "project (default, this repo) or user (global core.hooksPath)",
      ).choices(["project", "user"]),
    )
    .action((opts: { scope?: "project" | "user" }) => {
      if (opts.scope === "user") {
        uninstallGlobalHooks();
        return;
      }
      uninstallProjectHooks(getGitRoot());
    });
}
