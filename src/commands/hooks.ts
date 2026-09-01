/**
 * Hook management commands for the prim CLI.
 *
 * prim hooks install   — Install the prim git hooks (pre-commit + post-commit + post-rewrite)
 * prim hooks uninstall — Remove the prim git hooks
 *
 * Two scopes:
 *   project (default) — writes into this repo's .git/hooks (or .husky). Per-repo.
 *   user (--scope user) — installs ONCE at user level via a global
 *     `core.hooksPath`. The hooks fire in every repo but only ACT where prim is
 *     activated (`prim enable` / `git config prim.active`), so commit capture is
 *     opt-in per repo with no per-repo install — see lib/activation.ts.
 *
 * User-scope caveats (git's own precedence rules):
 *   - A repo with its OWN local `core.hooksPath` (e.g. husky v9 sets
 *     `.husky/_`) overrides the global one, so prim's global hook won't fire
 *     there — run per-repo `prim hooks install` in those repos.
 *   - If a global `core.hooksPath` already points elsewhere, prim appends its
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
import { dirname, join, resolve } from "node:path";
import { type Command, Option } from "commander";
import { commandMatchesBin, pinnedHookCommand } from "../lib/bin-path.js";
import { askConfirmation, isNonInteractive } from "../lib/confirmation.js";
import { gitToplevel } from "../lib/git.js";
import { primConfigDirectory } from "../lib/paths.js";
import {
  ensureEffectivePostCommitHook,
  ensureEffectivePostRewriteHook,
  ensurePostCommitHookAtPath,
  ensurePostRewriteHookAtPath,
  postCommitHookBlock,
  postRewriteHookBlock,
  uninstallPostCommitHookAtPath,
  uninstallPostRewriteHookAtPath,
  uninstallProjectPostCommitHook,
  uninstallProjectPostRewriteHook,
} from "../lib/post-commit-hook.js";

type HookSpec = { hookName: string; binName: string };

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

// A sentinel line every prim-MANAGED .git/hooks script carries, so the global
// hook's chain-back can recognize (and skip) a prim hook without matching the
// bare bin name — which a user's own hook might merely mention in a comment.
const PRIM_MANAGED_MARK = "prim-managed-hook";

// A provenance sentinel written ONLY into files prim itself creates (a foreign
// hooksPath dir that lacked the hook). Uninstall removes a stripped-empty file
// only when this marker is present, so prim never deletes a user's own hook it
// merely appended to.
const PRIM_CREATED_MARK = "prim-created-hook";

function hookShim(binName: string): string {
  return `{ ${pinnedHookCommand(binName)}; } || true`;
}

// hookShim, gated on the per-repo opt-in flag. Shared by the user-scope owned
// script and the coexist-append block so BOTH honor prim.active identically.
function gatedShim(binName: string): string {
  return `if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
${hookShim(binName)}
fi`;
}

function dotGitScript(spec: HookSpec): string {
  return `#!/bin/sh
# prim ${spec.hookName} hook — installed by: prim hooks install (${PRIM_MANAGED_MARK})

${hookShim(spec.binName)}
`;
}

function isOwnedStandalonePreCommit(content: string): boolean {
  if (content === "#!/bin/sh\nprim-pre-commit\n") return true;
  const prefix = `#!/bin/sh
# prim pre-commit hook — installed by: prim hooks install (${PRIM_MANAGED_MARK})

`;
  const suffix = "; } || true\n";
  if (!content.startsWith(prefix) || !content.endsWith(suffix)) return false;
  const body = content.slice(prefix.length, -suffix.length);
  if (!body.startsWith("{ ") || /[\r\n]/u.test(body)) return false;
  return commandMatchesBin(body.slice(2), PRE_COMMIT.binName);
}

function huskyBlock(spec: HookSpec): string {
  if (spec.hookName === POST_COMMIT.hookName) return postCommitHookBlock();
  if (spec.hookName === POST_REWRITE.hookName) return postRewriteHookBlock();
  const { start, end } = blockMarkers(spec);
  return `${start}
${hookShim(spec.binName)}
${end}`;
}

// The user-scope coexist block: like huskyBlock but GATED on prim.active, since
// at user scope prim must stay opt-in even when appended into a foreign
// core.hooksPath dir. Same markers, so stripPrimBlock removes it identically.
function gatedBlock(spec: HookSpec): string {
  if (spec.hookName === POST_COMMIT.hookName) return postCommitHookBlock();
  if (spec.hookName === POST_REWRITE.hookName) return postRewriteHookBlock();
  const { start, end } = blockMarkers(spec);
  return `${start}
${gatedShim(spec.binName)}
${end}`;
}

function primBlockRange(
  existing: string,
  spec: HookSpec,
): { start: number; through: number } | null {
  const { start, end } = blockMarkers(spec);
  const starts = existing.split(start).length - 1;
  const ends = existing.split(end).length - 1;
  if (starts === 0 && ends === 0) return null;
  const from = existing.indexOf(start);
  const endAt = existing.indexOf(end);
  if (starts !== 1 || ends !== 1 || endAt < from) {
    throw new Error(`malformed Prim hook markers for ${spec.hookName}`);
  }
  return { start: from, through: endAt + end.length };
}

// Append a marker-delimited block into a hook file, or create the file with a
// shebang if absent. Idempotent (no-op when the bin is already present).
// Returns whether it wrote. Shared by the husky and coexist-append paths.
function mergePrimBlock(hookPath: string, block: string, spec: HookSpec): boolean {
  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    const range = primBlockRange(existing, spec);
    if (range) {
      const refreshed = existing.slice(0, range.start) + block + existing.slice(range.through);
      if (refreshed === existing) return false;
      writeFileSync(hookPath, refreshed, { mode: 0o755 });
      return true;
    }
    if (containsPrimHook(existing, spec.binName)) return false;
    const separator = existing.endsWith("\n") ? "\n" : "\n\n";
    writeFileSync(hookPath, `${existing}${separator}${block}\n`, { mode: 0o755 });
    return true;
  }
  // Creating the file: the foreign hooksPath dir may not exist yet (a user set
  // core.hooksPath but never populated it), so ensure it. Stamp the provenance
  // marker so uninstall can safely remove a file prim created (vs. one it only
  // appended to).
  mkdirSync(dirname(hookPath), { recursive: true });
  writeFileSync(hookPath, `#!/bin/sh\n# ${PRIM_CREATED_MARK}\n\n${block}\n`, { mode: 0o755 });
  return true;
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

export function containsPrimHook(content: string, binName: string = PRE_COMMIT.binName): boolean {
  return content.includes(binName);
}

export function installToHusky(gitRoot: string, spec: HookSpec = PRE_COMMIT): void {
  const hookPath = resolve(gitRoot, ".husky", spec.hookName);
  const existed = existsSync(hookPath);
  const wrote = mergePrimBlock(hookPath, huskyBlock(spec), spec);
  if (!wrote) {
    console.log(`Prim ${spec.hookName} hook is already installed in .husky/${spec.hookName}.`);
  } else if (existed) {
    console.log(`Appended prim hook block to .husky/${spec.hookName}.`);
  } else {
    console.log(`Created .husky/${spec.hookName} with prim hook block.`);
  }
}

export function installToDotGit(gitRoot: string, spec: HookSpec = PRE_COMMIT): void {
  const hooksDir = projectHooksDir(gitRoot);
  const hookPath = resolve(hooksDir, spec.hookName);

  if (!existsSync(hooksDir)) {
    mkdirSync(hooksDir, { recursive: true });
  }

  if (existsSync(hookPath)) {
    const existing = readFileSync(hookPath, "utf-8");
    if (containsPrimHook(existing, spec.binName)) {
      console.log(`Prim ${spec.hookName} hook is already installed at ${hookPath}.`);
      return;
    }
    console.log(`A ${spec.hookName} hook already exists at ${hookPath}.`);
    console.log("To replace it, run: prim hooks uninstall && prim hooks install");
    return;
  }

  writeFileSync(hookPath, dotGitScript(spec), { mode: 0o755 });
  console.log(`Installed ${spec.hookName} hook at ${hookPath}`);
}

/**
 * Resolve the repository-owned hooks directory without following
 * core.hooksPath. In a linked worktree `<root>/.git` is a file, while Git's
 * common directory still owns the pre-commit hook that project scope manages.
 */
export function projectHooksDir(gitRoot: string): string {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: gitRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
  }).trim();
  if (commonDir === "") {
    throw new Error("git returned an empty common directory");
  }
  return resolve(gitRoot, commonDir, "hooks");
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

// A standalone global hook: gate prim on prim.active (gatedShim), then chain to
// the repo's own hook so a global core.hooksPath doesn't silently disable it.
// --git-common-dir is NOT core.hooksPath-aware, so the chained path is always
// the repo's real .git/hooks — never this script (no recursion). --git-path
// hooks/… IS core.hooksPath-aware and would self-reference, so it must not be
// used. The chain guard matches the legacy managed-hook sentinel or the current
// managed block marker (not the bare bin name, which a user's own hook might
// mention) to avoid double-invoking prim across project-to-user migrations.
function globalHookScript(spec: HookSpec): string {
  // pre-commit may legitimately block the commit — propagate the repo hook's
  // exit; post-commit/post-rewrite run after mutation and cannot block it.
  const chainExit = spec.hookName === PRE_COMMIT.hookName ? "|| exit $?" : "|| true";
  const managedBlock =
    spec.hookName === POST_COMMIT.hookName
      ? postCommitHookBlock()
      : spec.hookName === POST_REWRITE.hookName
        ? postRewriteHookBlock()
        : undefined;
  const invocation = managedBlock ?? gatedShim(spec.binName);
  const managedRepoGuard = managedBlock
    ? ` && ! grep -Fq '${blockMarkers(spec).start.slice(0, -3)}'">>>" "$repo_hook" 2>/dev/null`
    : "";
  const beforeComments = managedBlock ? `${invocation}\n` : "";
  const afterComments = managedBlock ? "" : `${invocation}\n`;
  return `#!/bin/sh
${beforeComments}# prim global ${spec.hookName} hook (core.hooksPath) — managed by prim; do not edit.
# Install/uninstall: prim hooks install|uninstall --scope user
# Runs prim only where activated — 'prim enable' (this repo) or
# 'git config --global prim.active true' (every repo). Chains to the repo's own
# hook regardless, so inactive repos are unaffected.
${afterComments}common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
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

const PINNED_PACKAGE_VERSION_RE =
  /@primitive\.ai\/prim@[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?/gu;

function normalizeOwnedGlobalHook(content: string, hookName: string): string | null {
  if (hookName === PRE_COMMIT.hookName) {
    const lines = content.split("\n");
    const invocationIndexes = lines.flatMap((line, index) =>
      line.startsWith("{ ") && line.endsWith("; } || true") ? [index] : [],
    );
    if (invocationIndexes.length !== 1) return null;
    const invocationIndex = invocationIndexes[0];
    const line = lines[invocationIndex];
    const command = line.slice(2, -"; } || true".length);
    if (!commandMatchesBin(command, PRE_COMMIT.binName)) return null;
    lines[invocationIndex] = "{ <recognized Prim pre-commit invocation>; } || true";
    return lines.join("\n");
  }
  return content.replace(PINNED_PACKAGE_VERSION_RE, "@primitive.ai/prim@<version>");
}

function isExpectedOwnedGlobalHook(content: string, hookName: string): boolean {
  const expected = expectedOwnedHookContent(hookName);
  if (expected === null) return false;
  if (content === expected) return true;
  const normalized = normalizeOwnedGlobalHook(content, hookName);
  const normalizedExpected = normalizeOwnedGlobalHook(expected, hookName);
  return normalized !== null && normalized === normalizedExpected;
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

function writeOwnHooks(): void {
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
}

/** Refresh Prim's wholly-owned global hooks without changing Git config. */
export function refreshOwnedGlobalHooks(): boolean {
  if (!isOurHooksDir(gitConfigGet("--global"))) return false;
  writeOwnHooks();
  return true;
}

// Append prim's GATED block into a hook file in a foreign global core.hooksPath
// dir we don't own. Idempotent. No chain tail: git already runs only this dir,
// so the file's other contents are the repo owner's, left in place. Gated, so
// user scope stays opt-in even here.
function appendPrimBlock(hookPath: string, spec: HookSpec): void {
  if (spec.hookName === POST_COMMIT.hookName) {
    ensurePostCommitHookAtPath(hookPath);
    return;
  }
  if (spec.hookName === POST_REWRITE.hookName) {
    ensurePostRewriteHookAtPath(hookPath);
    return;
  }
  mergePrimBlock(hookPath, gatedBlock(spec), spec);
}

function stripPrimBlock(hookPath: string, spec: HookSpec): void {
  if (spec.hookName === POST_COMMIT.hookName) {
    uninstallPostCommitHookAtPath(hookPath);
    return;
  }
  if (spec.hookName === POST_REWRITE.hookName) {
    uninstallPostRewriteHookAtPath(hookPath);
    return;
  }
  if (!existsSync(hookPath)) return;
  const existing = readFileSync(hookPath, "utf-8");
  const primCreated = existing.includes(PRIM_CREATED_MARK);
  const range = primBlockRange(existing, spec);
  if (!range) return;
  const out = (existing.slice(0, range.start) + existing.slice(range.through)).replace(
    /\n{2,}$/,
    "\n",
  );
  // Remove the file only when PRIM created it (provenance marker) and nothing
  // but prim's own scaffold (shebang + marker) is left — NEVER a user's own
  // hook prim merely appended to, even if that hook was shebang-only.
  const remainder = out.replaceAll("#!/bin/sh", "").replaceAll(`# ${PRIM_CREATED_MARK}`, "").trim();
  if (primCreated && remainder === "") {
    unlinkSync(hookPath);
    return;
  }
  writeFileSync(hookPath, out, { mode: 0o755 });
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
  if (primBlockRange(existing, PRE_COMMIT)) {
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

function applyPreCommitRemoval(plan: PreCommitRemovalPlan): void {
  if (plan.action === "remove-owned-file") {
    unlinkSync(plan.path);
    console.log(`Removed pre-commit hook at ${plan.path}`);
  } else if (plan.action === "strip-block") {
    stripPrimBlock(plan.path, PRE_COMMIT);
    console.log(`Removed the Prim pre-commit block from ${plan.path}.`);
  } else if (plan.action === "leave-foreign") {
    console.log(`Left pre-commit hook at ${plan.path} untouched (not a Prim hook).`);
  }
}

export function uninstallProjectHooks(gitRoot: string): void {
  // Preflight both possible pre-commit destinations before mutating either one.
  // This prevents a malformed/ambiguous Husky hook from causing a partial
  // deletion of the repository-owned .git hook (or vice versa).
  const plans = [
    planPreCommitRemoval(resolve(projectHooksDir(gitRoot), PRE_COMMIT.hookName), {
      allowOwnedStandalone: true,
    }),
    planPreCommitRemoval(resolve(gitRoot, ".husky", PRE_COMMIT.hookName), {
      allowOwnedStandalone: false,
    }),
  ];
  for (const plan of plans) applyPreCommitRemoval(plan);

  for (const [hookName, uninstall] of [
    [POST_COMMIT.hookName, uninstallProjectPostCommitHook],
    [POST_REWRITE.hookName, uninstallProjectPostRewriteHook],
  ] as const) {
    const result = uninstall(gitRoot);
    if (!result.changed) {
      console.log(`No Prim ${hookName} block found at ${result.path}.`);
    } else if (result.removedFile) {
      console.log(`Removed Prim-created ${hookName} hook at ${result.path}.`);
    } else {
      console.log(`Removed the Prim ${hookName} block from ${result.path}.`);
    }
  }
}

// Install prim's git hooks at USER scope via a global core.hooksPath. Coexists
// with an existing global hooksPath (appends into it) rather than clobbering.
// Returns whether hooks were installed — false when it declines (system
// hooksPath present without --force) so callers can report an honest skip.
export function installGlobalHooks(opts: { force?: boolean } = {}): boolean {
  const global = gitConfigGet("--global");
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
    writeOwnHooks();
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
    writeOwnHooks(); // idempotent refresh of the scripts
    console.log(`Prim global git hooks already active (${PRIM_GIT_HOOKS_DIR}); refreshed scripts.`);
    return true;
  }
  // Coexist: a global core.hooksPath already points elsewhere — append prim's
  // gated block into that dir and leave the pointer untouched.
  const dir = expandTilde(global);
  for (const spec of HOOKS) {
    appendPrimBlock(resolve(dir, spec.hookName), spec);
  }
  console.log(
    `Appended prim hooks into existing core.hooksPath dir ${global} (pointer unchanged).`,
  );
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

// Install every prim git hook (pre-commit + post-commit + post-rewrite) to the chosen
// destination, pre-commit first so its write is calls[0] in tests.
function installHooks(gitRoot: string, target: "husky" | "git-hooks"): void {
  if (target === "husky") {
    installToHusky(gitRoot, PRE_COMMIT);
  } else {
    installToDotGit(gitRoot, PRE_COMMIT);
  }
  const postCommit = ensureEffectivePostCommitHook(gitRoot);
  console.log(
    `${postCommit.changed ? "Installed" : "Refreshed"} effective post-commit hook at ${postCommit.path}.`,
  );
  try {
    const postRewrite = ensureEffectivePostRewriteHook(gitRoot);
    console.log(
      `${postRewrite.changed ? "Installed" : "Refreshed"} effective post-rewrite hook at ${postRewrite.path}.`,
    );
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`[prim] post-rewrite hook coverage is degraded: ${detail}`);
  }
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

        if (opts.target === "husky") return installHooks(gitRoot, "husky");
        if (opts.target === "git-hooks") return installHooks(gitRoot, "git-hooks");

        if (detectHusky(gitRoot)) {
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
        }

        installHooks(gitRoot, "git-hooks");
      },
    );

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
