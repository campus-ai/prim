import { GIT_HOOK_CACHE_SHELL_DIR, GIT_HOOK_CACHE_TTL_MINUTES } from "./bin-cache.js";
/**
 * Frozen recognition data for Git hook forms written before the v1 contract.
 *
 * Releases up to 0.1.0-alpha.93 inlined a version-pinned block into hook files
 * and into prim's own global hooks. Nothing here is ever written again; these
 * generators exist only so an older prim-owned global hook still proves its
 * ownership and stays removable after an upgrade. Do not edit the templates.
 */
import { commandMatchesBin, pinnedHookCommand, pinnedNpxCommand } from "./bin-path.js";
import type { ManagedGitHookName } from "./git-hook-contract.js";

const PRIM_MANAGED_MARK = "prim-managed-hook";

type HookSpec = { hookName: ManagedGitHookName; binName: string };

const PRE_COMMIT: HookSpec = { hookName: "pre-commit", binName: "prim-pre-commit" };
const POST_COMMIT: HookSpec = { hookName: "post-commit", binName: "prim-post-commit" };
const POST_REWRITE: HookSpec = { hookName: "post-rewrite", binName: "prim-post-rewrite" };

function blockMarkers(spec: HookSpec): { start: string; end: string } {
  return {
    start: `# >>> prim ${spec.hookName} hook >>>`,
    end: `# <<< prim ${spec.hookName} hook <<<`,
  };
}

function hookShim(binName: string): string {
  return `{ ${pinnedHookCommand(binName)}; } || true`;
}

function gatedShim(binName: string): string {
  return `if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
${hookShim(binName)}
fi`;
}

function legacyPostCommitBlock(): string {
  // This block is intentionally machine-independent. It uses the cache warmed
  // by SessionStart first, then the exact package version that installed it.
  // Every invocation is fail-soft and the block itself never exits the
  // surrounding foreign hook.
  return `# >>> prim post-commit hook >>>
if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
  prim_commit_sha=$(git rev-parse --verify HEAD 2>/dev/null) || prim_commit_sha=
  case "$prim_commit_sha" in *[!0-9a-f]*|"") prim_commit_sha= ;; esac
  case "\${#prim_commit_sha}" in 40|64) ;; *) prim_commit_sha= ;; esac
  if [ -n "$prim_commit_sha" ]; then
    prim_commit_observed_file=$(mktemp "\${TMPDIR:-/tmp}/prim-post-commit-observed.XXXXXXXX" 2>/dev/null) || prim_commit_observed_file=
    prim_commit_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || prim_commit_branch=
    prim_cache_dir="${GIT_HOOK_CACHE_SHELL_DIR}"
    prim_post_commit_ran=0
    if [ "\${PRIM_BIN_CACHE:-1}" != "0" ] && [ -f "$prim_cache_dir/prim-post-commit" ] && [ -f "$prim_cache_dir/node" ] && [ -n "$(find "$prim_cache_dir/prim-post-commit" -mmin "-\${PRIM_BIN_CACHE_TTL_MIN:-${GIT_HOOK_CACHE_TTL_MINUTES}}" 2>/dev/null)" ]; then
      prim_node=$(cat "$prim_cache_dir/node")
      prim_entry=$(cat "$prim_cache_dir/prim-post-commit")
      if [ -x "$prim_node" ] && [ -f "$prim_entry" ]; then
        ( trap '' HUP; trap 'if [ -n "$prim_commit_observed_file" ]; then rm -f "$prim_commit_observed_file"; fi' 0; export PRIM_COMMIT_SHA="$prim_commit_sha" PRIM_COMMIT_BRANCH="$prim_commit_branch" PRIM_COMMIT_OBSERVED_FILE="$prim_commit_observed_file"; "$prim_node" "$prim_entry" ) </dev/null >/dev/null 2>&1 &
        prim_post_commit_ran=1
      fi
    fi
    if [ "$prim_post_commit_ran" -eq 0 ] && command -v npx >/dev/null 2>&1; then
      ( trap '' HUP; trap 'if [ -n "$prim_commit_observed_file" ]; then rm -f "$prim_commit_observed_file"; fi' 0; export PRIM_COMMIT_SHA="$prim_commit_sha" PRIM_COMMIT_BRANCH="$prim_commit_branch" PRIM_COMMIT_OBSERVED_FILE="$prim_commit_observed_file"; ${pinnedNpxCommand("prim-post-commit")} ) </dev/null >/dev/null 2>&1 &
      prim_post_commit_ran=1
    fi
    if [ "$prim_post_commit_ran" -eq 0 ] && [ -n "$prim_commit_observed_file" ]; then
      rm -f "$prim_commit_observed_file"
    fi
    unset prim_cache_dir prim_post_commit_ran prim_node prim_entry prim_commit_branch prim_commit_observed_file
  fi
  unset prim_commit_sha
fi
# <<< prim post-commit hook <<<`;
}

function legacyPostRewriteBlock(): string {
  return `# >>> prim post-rewrite hook >>>
if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
  case "$1" in amend|rebase) prim_rewrite_source="$1" ;; *) prim_rewrite_source= ;; esac
  if [ -n "$prim_rewrite_source" ]; then
    prim_rewrite_pairs_file=$(mktemp "\${TMPDIR:-/tmp}/prim-post-rewrite-pairs.XXXXXXXX" 2>/dev/null) || prim_rewrite_pairs_file=
    if [ -n "$prim_rewrite_pairs_file" ] && ! chmod 600 "$prim_rewrite_pairs_file" 2>/dev/null; then
      rm -f "$prim_rewrite_pairs_file"
      prim_rewrite_pairs_file=
    fi
    if [ -n "$prim_rewrite_pairs_file" ]; then
      if cat > "$prim_rewrite_pairs_file"; then
        exec < "$prim_rewrite_pairs_file"
        prim_rewrite_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || prim_rewrite_branch=
        prim_cache_dir="${GIT_HOOK_CACHE_SHELL_DIR}"
        prim_post_rewrite_ran=0
        if [ "\${PRIM_BIN_CACHE:-1}" != "0" ] && [ -f "$prim_cache_dir/prim-post-rewrite" ] && [ -f "$prim_cache_dir/node" ] && [ -n "$(find "$prim_cache_dir/prim-post-rewrite" -mmin "-\${PRIM_BIN_CACHE_TTL_MIN:-${GIT_HOOK_CACHE_TTL_MINUTES}}" 2>/dev/null)" ]; then
          prim_node=$(cat "$prim_cache_dir/node")
          prim_entry=$(cat "$prim_cache_dir/prim-post-rewrite")
          if [ -x "$prim_node" ] && [ -f "$prim_entry" ]; then
            ( trap '' HUP; trap 'if [ -n "$prim_rewrite_pairs_file" ]; then rm -f "$prim_rewrite_pairs_file"; fi' 0; export PRIM_REWRITE_SOURCE="$prim_rewrite_source" PRIM_REWRITE_BRANCH="$prim_rewrite_branch" PRIM_REWRITE_PAIRS_FILE="$prim_rewrite_pairs_file"; "$prim_node" "$prim_entry" ) </dev/null >/dev/null 2>&1 &
            prim_post_rewrite_ran=1
          fi
        fi
        if [ "$prim_post_rewrite_ran" -eq 0 ] && command -v npx >/dev/null 2>&1; then
          ( trap '' HUP; trap 'if [ -n "$prim_rewrite_pairs_file" ]; then rm -f "$prim_rewrite_pairs_file"; fi' 0; export PRIM_REWRITE_SOURCE="$prim_rewrite_source" PRIM_REWRITE_BRANCH="$prim_rewrite_branch" PRIM_REWRITE_PAIRS_FILE="$prim_rewrite_pairs_file"; ${pinnedNpxCommand("prim-post-rewrite")} ) </dev/null >/dev/null 2>&1 &
          prim_post_rewrite_ran=1
        fi
        if [ "$prim_post_rewrite_ran" -eq 0 ]; then
          rm -f "$prim_rewrite_pairs_file"
        fi
        unset prim_cache_dir prim_post_rewrite_ran prim_node prim_entry prim_rewrite_branch
      else
        rm -f "$prim_rewrite_pairs_file"
      fi
      unset prim_rewrite_pairs_file
    fi
  fi
  unset prim_rewrite_source
fi
# <<< prim post-rewrite hook <<<`;
}

function legacyGlobalHookScript(spec: HookSpec): string {
  // pre-commit may legitimately block the commit — propagate the repo hook's
  // exit; post-commit/post-rewrite run after mutation and cannot block it.
  const chainExit = spec.hookName === PRE_COMMIT.hookName ? "|| exit $?" : "|| true";
  const managedBlock =
    spec.hookName === POST_COMMIT.hookName
      ? legacyPostCommitBlock()
      : spec.hookName === POST_REWRITE.hookName
        ? legacyPostRewriteBlock()
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

/** Whether `content` is a prim-owned global hook written by a pre-v1 release. */
export function isLegacyOwnedGlobalHook(content: string, hookName: ManagedGitHookName): boolean {
  const spec = [PRE_COMMIT, POST_COMMIT, POST_REWRITE].find((s) => s.hookName === hookName);
  if (!spec) return false;
  const expected = legacyGlobalHookScript(spec);
  if (content === expected) return true;
  const normalized = normalizeOwnedGlobalHook(content, hookName);
  return normalized !== null && normalized === normalizeOwnedGlobalHook(expected, hookName);
}

/**
 * The inline block a pre-v1 release wrote into hook files. Repos that have not
 * been re-wired since still run it, which is why SessionStart keeps warming
 * the bin cache these blocks read.
 */
export function legacyInlineHookBlock(hookName: "post-commit" | "post-rewrite"): string {
  return hookName === "post-commit" ? legacyPostCommitBlock() : legacyPostRewriteBlock();
}
