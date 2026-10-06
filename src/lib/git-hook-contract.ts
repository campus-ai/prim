/**
 * The frozen v1 contract between a Git hook file and prim.
 *
 * Two artifacts, both byte-stable across releases:
 *
 * - The managed block that `prim enable` / `prim hooks install` write into a
 *   hook file (possibly a tracked `.husky/*` file). It resolves prim's config
 *   root exactly as `primConfigDirectory` does and execs the entrypoint below.
 *   It names no version, machine path, or Node runtime, so no release ever has
 *   a reason to rewrite it.
 * - The entrypoint `<config>/prim-git-hook-v1`, staged with the immutable hook
 *   runtime. It gates on `prim.active`, snapshots what Git provides
 *   synchronously (HEAD, branch, rewrite pairs), and hands off to the
 *   version-selecting `prim-hook-launcher-v1`. Behavior that evolves lives in
 *   the Node entries of the selected release, never here.
 *
 * Changing either string changes a contract that hook files in the wild
 * depend on: add a `v2` name instead of editing these bytes.
 */
import { PRIM_CONFIG_SHELL_RESOLVER, STABLE_HOOK_LAUNCHER_NAME, shellQuote } from "./bin-path.js";

export const MANAGED_GIT_HOOK_NAMES = ["pre-commit", "post-commit", "post-rewrite"] as const;
export type ManagedGitHookName = (typeof MANAGED_GIT_HOOK_NAMES)[number];

export const GIT_HOOK_ENTRYPOINT_NAME = "prim-git-hook-v1";
export const GIT_HOOK_CONTRACT_VERSION = 1;

/** The version line every managed block carries after its start marker. */
const CONTRACT_LINE_PREFIX = "# prim git hook v";
const CONTRACT_LINE_RE = /^# prim git hook v([0-9]+)\b/mu;

export function blockMarkers(hook: ManagedGitHookName): { start: string; end: string } {
  return { start: `# >>> prim ${hook} hook >>>`, end: `# <<< prim ${hook} hook <<<` };
}

/**
 * Exec the entrypoint under the canonical config root, or do nothing. A
 * missing entrypoint (prim not installed on this machine) and an unusable
 * HOME both leave the calling hook unaffected.
 */
function entrypointCommand(hook: ManagedGitHookName): string {
  const script = [
    PRIM_CONFIG_SHELL_RESOLVER,
    `case "$prim_config" in /) prim_entry=/${GIT_HOOK_ENTRYPOINT_NAME} ;; `,
    `*) prim_entry="$prim_config/${GIT_HOOK_ENTRYPOINT_NAME}" ;; esac; `,
    '[ -x "$prim_entry" ] || exit 0; exec "$prim_entry" "$@"',
  ].join("");
  return `/bin/sh -c ${shellQuote(script)} ${GIT_HOOK_ENTRYPOINT_NAME} ${hook} "$@"`;
}

/**
 * The block wired into a hook file. post-rewrite snapshots Git's stdin to a
 * private file, feeds prim from it, and re-arms the hook's own stdin from the
 * same file, so code after the block still reads every rewrite pair.
 */
export function managedHookBlock(hook: ManagedGitHookName): string {
  const { start, end } = blockMarkers(hook);
  const header = `${CONTRACT_LINE_PREFIX}${GIT_HOOK_CONTRACT_VERSION}: a no-op unless prim is installed and enabled here (see \`prim hooks snippet ${hook}\`).`;
  if (hook !== "post-rewrite") {
    return `${start}
${header}
# shellcheck disable=SC2016
${entrypointCommand(hook)} || :
${end}`;
  }
  return `${start}
${header}
prim_rewrite_stdin=$(mktemp 2>/dev/null) || prim_rewrite_stdin=
if test -n "\${prim_rewrite_stdin}" && cat >"\${prim_rewrite_stdin}"; then
  # shellcheck disable=SC2016
  ${entrypointCommand(hook)} <"\${prim_rewrite_stdin}" || :
  exec <"\${prim_rewrite_stdin}"
fi
if test -n "\${prim_rewrite_stdin}"; then rm -f "\${prim_rewrite_stdin}"; fi
unset prim_rewrite_stdin
${end}`;
}

/**
 * Compare blocks modulo formatting. Formatters such as shfmt re-indent,
 * re-space redirections, and break `if …; then …; fi` across lines; none of
 * that may look stale, or prim would rewrite the user's formatted bytes and
 * reintroduce churn. Line structure still matters where it changes meaning: a
 * comment is one token running to the end of its line, so a command joined
 * onto a comment line (which silences it) never compares equal.
 */
export function canonicalHookBlock(text: string): string {
  const tokens: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#")) {
      tokens.push(line.replace(/\s+/gu, " "));
      continue;
    }
    for (const word of line.replace(/([<>])\s+/gu, "$1").split(/[\s;]+/u)) {
      if (word !== "") tokens.push(word);
    }
  }
  return tokens.join("\u0000");
}

/** The contract version a block declares, or undefined for pre-v1 blocks. */
export function hookBlockContractVersion(block: string): number | undefined {
  const match = CONTRACT_LINE_RE.exec(block);
  return match?.[1] ? Number(match[1]) : undefined;
}

/**
 * Frozen entrypoint bytes. Every branch exits 0: pre-commit is warn-only and
 * the post hooks run after Git has already moved HEAD.
 */
export const GIT_HOOK_ENTRYPOINT_CONTENT = `#!/bin/sh
# prim git hook entrypoint v1 — managed by prim; do not edit.
# Run by the "# >>> prim <hook> hook >>>" block in a Git hook file. Acts only
# where prim is active (git config prim.active true) and never fails the hook.
case "$0" in */*) prim_dir=\${0%/*} ;; *) exit 0 ;; esac
prim_launcher="$prim_dir/${STABLE_HOOK_LAUNCHER_NAME}"
[ -x "$prim_launcher" ] || exit 0
[ "$(git config --get prim.active 2>/dev/null)" = "true" ] || exit 0
prim_hook=\${1-}
if [ "$#" -gt 0 ]; then shift; fi
case "$prim_hook" in
pre-commit)
  "$prim_launcher" prim-pre-commit "$@" || :
  ;;
post-commit)
  prim_sha=$(git rev-parse --verify HEAD 2>/dev/null) || exit 0
  case "$prim_sha" in *[!0-9a-f]* | "") exit 0 ;; esac
  case "\${#prim_sha}" in 40 | 64) ;; *) exit 0 ;; esac
  prim_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || prim_branch=
  prim_observed=$(mktemp "\${TMPDIR:-/tmp}/prim-post-commit-observed.XXXXXXXX" 2>/dev/null) || prim_observed=
  (
    trap '' HUP
    trap 'if [ -n "$prim_observed" ]; then rm -f "$prim_observed"; fi' 0
    PRIM_COMMIT_SHA=$prim_sha PRIM_COMMIT_BRANCH=$prim_branch PRIM_COMMIT_OBSERVED_FILE=$prim_observed "$prim_launcher" prim-post-commit
  ) </dev/null >/dev/null 2>&1 &
  ;;
post-rewrite)
  case "\${1-}" in amend | rebase) prim_source=$1 ;; *) exit 0 ;; esac
  prim_pairs=$(mktemp "\${TMPDIR:-/tmp}/prim-post-rewrite-pairs.XXXXXXXX" 2>/dev/null) || exit 0
  if ! chmod 600 "$prim_pairs" 2>/dev/null || ! cat >"$prim_pairs"; then
    rm -f "$prim_pairs"
    exit 0
  fi
  prim_branch=$(git symbolic-ref --quiet --short HEAD 2>/dev/null) || prim_branch=
  (
    trap '' HUP
    trap 'rm -f "$prim_pairs"' 0
    PRIM_REWRITE_SOURCE=$prim_source PRIM_REWRITE_BRANCH=$prim_branch PRIM_REWRITE_PAIRS_FILE=$prim_pairs "$prim_launcher" prim-post-rewrite
  ) </dev/null >/dev/null 2>&1 &
  ;;
esac
exit 0
`;
