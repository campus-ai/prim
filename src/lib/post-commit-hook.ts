import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fchmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import type { Stats } from "node:fs";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { GIT_HOOK_CACHE_SHELL_DIR, GIT_HOOK_CACHE_TTL_MINUTES } from "./bin-cache.js";
import { pinnedNpxCommand } from "./bin-path.js";
import { gitToplevel } from "./git.js";

export const PRIM_POST_COMMIT_BLOCK_START = "# >>> prim post-commit hook >>>";
export const PRIM_POST_COMMIT_BLOCK_END = "# <<< prim post-commit hook <<<";
const PRIM_CREATED_MARK = "prim-created-post-commit-hook";
export const PRIM_POST_REWRITE_BLOCK_START = "# >>> prim post-rewrite hook >>>";
export const PRIM_POST_REWRITE_BLOCK_END = "# <<< prim post-rewrite hook <<<";
const PRIM_POST_REWRITE_CREATED_MARK = "prim-created-post-rewrite-hook";
const LEGACY_PRIM_CREATED_MARK = "prim-created-hook";
const LEGACY_PRIM_OWNED_HEADER =
  "# prim post-commit hook — installed by: prim hooks install (prim-managed-hook)";
const LEGACY_GLOBAL_OWNED_HEADER =
  "# prim global post-commit hook (core.hooksPath) — managed by prim; do not edit.";
const MAX_HOOK_BYTES = 1_048_576;
const GIT_TIMEOUT_MS = 1_000;
const SUPPORTED_SHEBANGS = new Set([
  "#!/bin/sh",
  "#!/usr/bin/env sh",
  "#!/bin/bash",
  "#!/usr/bin/env bash",
  "#!/bin/zsh",
  "#!/usr/bin/env zsh",
]);
const HUSKY_V9_DISPATCHERS = new Set([
  '#!/usr/bin/env sh\n. "${0%/*}/h"',
  '#!/usr/bin/env sh\n. "$(dirname "$0")/h"',
]);
const HUSKY_DIRECT_DISPATCHER = '#!/bin/sh\nexec sh "$(dirname "$0")/../post-commit"\n';
// Exact SHA-256s of the eight dispatcher runtimes shipped across Husky 9.x.
// Pinning the bytes lets us prove public-hook delegation without interpreting
// arbitrary shell in Husky's generated `_` directory.
const HUSKY_V9_RUNTIME_HASHES = new Set([
  "d6aaa6f3f7c11008c525e649161df4a93152f1e55d0887fa1d7b8d622735d380",
  "b02cb91cab7125a9e906be723a1b85297fc435a8307d429ae845546b4ee0ecde",
  "9db5d129c4eb822a773157d98cd8fb8f1b156b85e3193117fefe527ca6d45e91",
  "3b2cb21335e544b4ebce658ca47af4a69d2c77026cc4d3f8b2227c34d062b207",
  "548990e1c11285694096184993d907b258d41235461a7ca2551e3b53ff9d3a38",
  "c029a943acea5d6e2ddbaa271a1fb22c2da55d56b5c6fb59ca804ac9a4018708",
  "ae3413a8fe2b39372de48bdc9691f42055f089c0c7529834b2fb07a131585b6a",
  "70200b200ca709b0622784f93839a5b2872333a917a09afddefd7dc2d8cdc680",
]);

export type ManagedHookSpec = {
  hookName: string;
  blockStart: string;
  blockEnd: string;
  createdMark: string;
  block: () => string;
};

export type EffectiveManagedHook = {
  gitRoot: string;
  hooksDir: string;
  hookPath: string;
  kind: "direct" | "husky_v9";
  /** Husky's generated dispatcher. Prim observes it but never writes it. */
  dispatcherPath?: string;
};

export type ManagedHookInspection = EffectiveManagedHook & {
  covered: boolean;
  executable: boolean;
  current: boolean;
  reason?:
    | "missing"
    | "binary"
    | "malformed_markers"
    | "unsafe_target"
    | "stale_block"
    | "husky_dispatcher_missing"
    | "husky_dispatcher_invalid"
    | "unsupported_interpreter"
    | "unreachable_block"
    | "not_executable";
};

export type EffectivePostCommitHook = EffectiveManagedHook;
export type PostCommitHookInspection = ManagedHookInspection;
export type EffectivePostRewriteHook = EffectiveManagedHook;
export type PostRewriteHookInspection = ManagedHookInspection;

function currentPostCommitBlock(): string {
  // This block is intentionally machine-independent. It uses the cache warmed
  // by SessionStart first, then a checkout-local bin, then the exact package
  // version that installed it. Every invocation is fail-soft and the block
  // itself never exits the surrounding foreign hook.
  return `${PRIM_POST_COMMIT_BLOCK_START}
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
    if [ "$prim_post_commit_ran" -eq 0 ]; then
      if [ -x "./node_modules/.bin/prim-post-commit" ]; then
        ( trap '' HUP; trap 'if [ -n "$prim_commit_observed_file" ]; then rm -f "$prim_commit_observed_file"; fi' 0; export PRIM_COMMIT_SHA="$prim_commit_sha" PRIM_COMMIT_BRANCH="$prim_commit_branch" PRIM_COMMIT_OBSERVED_FILE="$prim_commit_observed_file"; ./node_modules/.bin/prim-post-commit ) </dev/null >/dev/null 2>&1 &
        prim_post_commit_ran=1
      elif command -v npx >/dev/null 2>&1; then
        ( trap '' HUP; trap 'if [ -n "$prim_commit_observed_file" ]; then rm -f "$prim_commit_observed_file"; fi' 0; export PRIM_COMMIT_SHA="$prim_commit_sha" PRIM_COMMIT_BRANCH="$prim_commit_branch" PRIM_COMMIT_OBSERVED_FILE="$prim_commit_observed_file"; ${pinnedNpxCommand("prim-post-commit")} ) </dev/null >/dev/null 2>&1 &
        prim_post_commit_ran=1
      fi
    fi
    if [ "$prim_post_commit_ran" -eq 0 ] && [ -n "$prim_commit_observed_file" ]; then
      rm -f "$prim_commit_observed_file"
    fi
    unset prim_cache_dir prim_post_commit_ran prim_node prim_entry prim_commit_branch prim_commit_observed_file
  fi
  unset prim_commit_sha
fi
${PRIM_POST_COMMIT_BLOCK_END}`;
}

export function postCommitHookBlock(): string {
  return currentPostCommitBlock();
}

/**
 * Capture post-rewrite stdin before detaching the Node driver. Reopening the
 * private pairs file on fd 0 is load-bearing: any foreign hook body after
 * Prim's block still receives Git's original rewrite mapping even after the
 * detached driver unlinks the pathname.
 */
export function postRewriteHookBlock(): string {
  return `${PRIM_POST_REWRITE_BLOCK_START}
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
        if [ "$prim_post_rewrite_ran" -eq 0 ]; then
          if [ -x "./node_modules/.bin/prim-post-rewrite" ]; then
            ( trap '' HUP; trap 'if [ -n "$prim_rewrite_pairs_file" ]; then rm -f "$prim_rewrite_pairs_file"; fi' 0; export PRIM_REWRITE_SOURCE="$prim_rewrite_source" PRIM_REWRITE_BRANCH="$prim_rewrite_branch" PRIM_REWRITE_PAIRS_FILE="$prim_rewrite_pairs_file"; ./node_modules/.bin/prim-post-rewrite ) </dev/null >/dev/null 2>&1 &
            prim_post_rewrite_ran=1
          elif command -v npx >/dev/null 2>&1; then
            ( trap '' HUP; trap 'if [ -n "$prim_rewrite_pairs_file" ]; then rm -f "$prim_rewrite_pairs_file"; fi' 0; export PRIM_REWRITE_SOURCE="$prim_rewrite_source" PRIM_REWRITE_BRANCH="$prim_rewrite_branch" PRIM_REWRITE_PAIRS_FILE="$prim_rewrite_pairs_file"; ${pinnedNpxCommand("prim-post-rewrite")} ) </dev/null >/dev/null 2>&1 &
            prim_post_rewrite_ran=1
          fi
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
${PRIM_POST_REWRITE_BLOCK_END}`;
}

export const POST_COMMIT_MANAGED_HOOK: ManagedHookSpec = {
  hookName: "post-commit",
  blockStart: PRIM_POST_COMMIT_BLOCK_START,
  blockEnd: PRIM_POST_COMMIT_BLOCK_END,
  createdMark: PRIM_CREATED_MARK,
  block: postCommitHookBlock,
};

export const POST_REWRITE_MANAGED_HOOK: ManagedHookSpec = {
  hookName: "post-rewrite",
  blockStart: PRIM_POST_REWRITE_BLOCK_START,
  blockEnd: PRIM_POST_REWRITE_BLOCK_END,
  createdMark: PRIM_POST_REWRITE_CREATED_MARK,
  block: postRewriteHookBlock,
};

function legacyFloatingInvocation(): string {
  return `if command -v prim-post-commit >/dev/null 2>&1; then
  prim-post-commit || true
elif [ -f "./node_modules/.bin/prim-post-commit" ]; then
  ./node_modules/.bin/prim-post-commit || true
else
  npx --yes -p @primitive.ai/prim prim-post-commit 2>/dev/null || true
fi`;
}

function legacyGlobalGate(): Buffer {
  return Buffer.from(`if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
${legacyFloatingInvocation()}
fi
`);
}

const PINNED_INVOCATION_RE =
  /^\{ if \[ -x (?<node>'.*') \] && \[ -f (?<entry>'.*') \]; then \k<node> \k<entry>; else npx --yes -p @primitive\.ai\/prim@(?<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?) prim-post-commit; fi; \} \|\| true$/u;
const SHELL_QUOTED_RE = /^'(?:[^']|'"'"')*'$/u;

function decodePinnedPath(token: string | undefined): string | undefined {
  if (!token || !SHELL_QUOTED_RE.test(token)) return undefined;
  const value = token.slice(1, -1).replaceAll(`'"'"'`, "'");
  if (!isAbsolute(value) || value.includes("\0") || value.includes("\n") || value.includes("\r")) {
    return undefined;
  }
  return value;
}

function isPinnedInvocation(value: string): boolean {
  const match = PINNED_INVOCATION_RE.exec(value);
  const node = decodePinnedPath(match?.groups?.node);
  const entry = decodePinnedPath(match?.groups?.entry);
  return Boolean(node && entry?.endsWith("/dist/hooks/post-commit.js"));
}

function legacyProjectPrefixLength(existing: Buffer): number | undefined {
  const prefix = Buffer.from(`#!/bin/sh\n${LEGACY_PRIM_OWNED_HEADER}\n\n`);
  if (!existing.subarray(0, prefix.length).equals(prefix)) return undefined;
  const floating = Buffer.from(`${legacyFloatingInvocation()}\n`);
  if (existing.subarray(prefix.length, prefix.length + floating.length).equals(floating)) {
    return prefix.length + floating.length;
  }
  const invocationEnd = existing.indexOf(10, prefix.length);
  if (invocationEnd === -1) return undefined;
  const invocation = existing.subarray(prefix.length, invocationEnd).toString("utf8");
  return isPinnedInvocation(invocation) ? invocationEnd + 1 : undefined;
}

function isKnownLegacyGlobalGate(value: Buffer): boolean {
  if (value.equals(legacyGlobalGate())) return true;
  const prefix = Buffer.from(
    'if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then\n',
  );
  const suffix = Buffer.from("\nfi\n");
  return (
    value.subarray(0, prefix.length).equals(prefix) &&
    value.subarray(-suffix.length).equals(suffix) &&
    isPinnedInvocation(value.subarray(prefix.length, -suffix.length).toString("utf8"))
  );
}

function createdScaffold(spec: ManagedHookSpec): Buffer {
  return Buffer.from(`#!/bin/sh\n${spec.block()}\n# ${spec.createdMark}\n`);
}

function safeGitPath(root: string, value: string): string {
  if (
    value.length === 0 ||
    value !== value.trim() ||
    value.includes("\0") ||
    value.includes("\n") ||
    value.includes("\r")
  ) {
    throw new Error("Git returned an unsafe hooks path");
  }
  return isAbsolute(value) ? resolve(value) : resolve(root, value);
}

/** Resolve the destination Git actually invokes, including worktrees/overrides. */
function resolveEffectiveManagedHook(
  spec: ManagedHookSpec,
  cwd: string = process.cwd(),
): EffectiveManagedHook {
  const gitRoot = gitToplevel(cwd);
  if (!gitRoot) throw new Error("not a git repository");
  const value = execFileSync("git", ["rev-parse", "--git-path", "hooks"], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
  }).replace(/\r?\n$/u, "");
  const hooksDir = safeGitPath(gitRoot, value);
  if (basename(hooksDir) === "_" && basename(dirname(hooksDir)) === ".husky") {
    return {
      gitRoot,
      hooksDir,
      hookPath: resolve(dirname(hooksDir), spec.hookName),
      kind: "husky_v9",
      dispatcherPath: resolve(hooksDir, spec.hookName),
    };
  }
  return {
    gitRoot,
    hooksDir,
    hookPath: resolve(hooksDir, spec.hookName),
    kind: "direct",
  };
}

export function resolveEffectivePostCommitHook(
  cwd: string = process.cwd(),
): EffectivePostCommitHook {
  return resolveEffectiveManagedHook(POST_COMMIT_MANAGED_HOOK, cwd);
}

export function resolveEffectivePostRewriteHook(
  cwd: string = process.cwd(),
): EffectivePostRewriteHook {
  return resolveEffectiveManagedHook(POST_REWRITE_MANAGED_HOOK, cwd);
}

function assertSafeFile(path: string, spec: ManagedHookSpec): Stats | undefined {
  if (!existsSync(path)) return undefined;
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_HOOK_BYTES) {
    throw new Error(`unsafe ${spec.hookName} hook target: ${path}`);
  }
  return stat;
}

function assertUsableHuskyDispatcher(target: EffectiveManagedHook, spec: ManagedHookSpec): void {
  if (!target.dispatcherPath) return;
  const stat = assertSafeFile(target.dispatcherPath, spec);
  if (!stat || (stat.mode & 0o100) === 0) {
    throw new Error(
      `Husky ${spec.hookName} dispatcher is missing or not executable: ${target.dispatcherPath}`,
    );
  }
  const dispatcher = decodeHookText(readHookFile(target.dispatcherPath), spec);
  const directDispatcher = HUSKY_DIRECT_DISPATCHER.replaceAll("post-commit", spec.hookName);
  if (dispatcher === directDispatcher) return;
  const normalizedDispatcher = dispatcher.endsWith("\n") ? dispatcher.slice(0, -1) : dispatcher;
  if (!HUSKY_V9_DISPATCHERS.has(normalizedDispatcher)) {
    throw new Error(`unrecognized Husky ${spec.hookName} dispatcher: ${target.dispatcherPath}`);
  }
  const huskyRuntime = resolve(dirname(target.dispatcherPath), "h");
  const runtimeStat = assertSafeFile(huskyRuntime, spec);
  const runtime = runtimeStat ? readHookFile(huskyRuntime) : undefined;
  const runtimeHash = runtime ? createHash("sha256").update(runtime).digest("hex") : undefined;
  if (!runtimeHash || !HUSKY_V9_RUNTIME_HASHES.has(runtimeHash)) {
    throw new Error(`unrecognized Husky v9 hook runtime: ${huskyRuntime}`);
  }
}

function readHookFile(path: string): Buffer {
  const value = readFileSync(path);
  return Buffer.isBuffer(value) ? value : Buffer.from(value as unknown as string);
}

function decodeHookText(content: Buffer, spec: ManagedHookSpec): string {
  if (content.includes(0)) throw new Error(`binary ${spec.hookName} hook`);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    throw new Error(`binary ${spec.hookName} hook`);
  }
}

function supportedShebangEnd(content: Buffer, spec: ManagedHookSpec): number {
  const text = decodeHookText(content, spec);
  const newline = text.indexOf("\n");
  const shebang = newline === -1 ? text : text.slice(0, newline);
  if (!SUPPORTED_SHEBANGS.has(shebang) || newline === -1) {
    throw new Error(`unsupported ${spec.hookName} hook interpreter`);
  }
  return Buffer.byteLength(text.slice(0, newline + 1), "utf8");
}

function shellInsertionPoint(
  content: Buffer,
  allowShebangless: boolean,
  spec: ManagedHookSpec,
): number {
  const text = decodeHookText(content, spec);
  if (text.startsWith("#!")) return supportedShebangEnd(content, spec);
  if (allowShebangless) return 0;
  throw new Error(`unsupported ${spec.hookName} hook interpreter`);
}

type BlockRange =
  | { kind: "absent" }
  | { kind: "current"; start: number; end: number }
  | { kind: "stale"; start: number; end: number };

function allIndexes(haystack: Buffer, needle: Buffer): number[] {
  const indexes: number[] = [];
  let offset = 0;
  while (offset <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, offset);
    if (index === -1) break;
    indexes.push(index);
    offset = index + needle.length;
  }
  return indexes;
}

function blockRange(content: Buffer, spec: ManagedHookSpec): BlockRange {
  decodeHookText(content, spec);
  const startMarker = Buffer.from(spec.blockStart);
  const endMarker = Buffer.from(spec.blockEnd);
  const starts = allIndexes(content, startMarker);
  const ends = allIndexes(content, endMarker);
  if (starts.length === 0 && ends.length === 0) return { kind: "absent" };
  if (starts.length !== 1 || ends.length !== 1 || ends[0] < starts[0]) {
    throw new Error(`malformed Prim ${spec.hookName} markers`);
  }
  const start = starts[0];
  const end = ends[0] + endMarker.length;
  const current = Buffer.from(spec.block());
  return content.subarray(start, end).equals(current)
    ? { kind: "current", start, end }
    : { kind: "stale", start, end };
}

function mergedContent(
  existing: Buffer | undefined,
  allowShebangless: boolean,
  spec: ManagedHookSpec,
): Buffer {
  const block = Buffer.from(spec.block());
  if (!existing) {
    return createdScaffold(spec);
  }
  const range = blockRange(existing, spec);
  if (
    spec.hookName === POST_COMMIT_MANAGED_HOOK.hookName &&
    range.kind === "absent" &&
    existing.toString("utf8").startsWith(`#!/bin/sh\n${LEGACY_GLOBAL_OWNED_HEADER}\n`)
  ) {
    const gateAt = existing.indexOf(Buffer.from('if [ "$(git config --get prim.active'));
    const chainAt = existing.indexOf(Buffer.from("common_dir=$(git rev-parse --git-common-dir"));
    if (gateAt === -1 || chainAt <= gateAt) {
      throw new Error("malformed legacy Prim global post-commit hook");
    }
    if (!isKnownLegacyGlobalGate(existing.subarray(gateAt, chainAt))) {
      throw new Error("unrecognized legacy Prim global post-commit invocation");
    }
    const withoutLegacyGate = Buffer.concat([
      existing.subarray(0, gateAt),
      existing.subarray(chainAt),
    ]);
    const shebangEnd = shellInsertionPoint(withoutLegacyGate, allowShebangless, spec);
    return Buffer.concat([
      withoutLegacyGate.subarray(0, shebangEnd),
      block,
      Buffer.from("\n"),
      withoutLegacyGate.subarray(shebangEnd),
    ]);
  }
  if (
    spec.hookName === POST_COMMIT_MANAGED_HOOK.hookName &&
    range.kind === "absent" &&
    existing.toString("utf8").startsWith(`#!/bin/sh\n${LEGACY_PRIM_OWNED_HEADER}\n`)
  ) {
    const prefixLength = legacyProjectPrefixLength(existing);
    if (prefixLength === undefined) {
      throw new Error("unrecognized legacy Prim post-commit invocation");
    }
    return Buffer.concat([createdScaffold(spec), existing.subarray(prefixLength)]);
  }
  if (range.kind !== "absent") {
    const oldCreatedPrefixes = [
      Buffer.from(`#!/bin/sh\n# ${spec.createdMark}\n\n`),
      ...(spec.hookName === POST_COMMIT_MANAGED_HOOK.hookName
        ? [Buffer.from(`#!/bin/sh\n# ${LEGACY_PRIM_CREATED_MARK}\n\n`)]
        : []),
    ];
    const oldCreated = oldCreatedPrefixes.some(
      (prefix) =>
        range.start === prefix.length && existing.subarray(0, prefix.length).equals(prefix),
    );
    if (oldCreated) {
      const suffix = existing.subarray(range.end);
      const tail = suffix.at(0) === 10 ? suffix.subarray(1) : suffix;
      return Buffer.concat([createdScaffold(spec), tail]);
    }
  }
  const shebangEnd = shellInsertionPoint(existing, allowShebangless, spec);
  if (range.kind === "current" && range.start === shebangEnd) return existing;
  let withoutBlock = existing;
  if (range.kind !== "absent") {
    const suffix = existing.subarray(range.end);
    withoutBlock = Buffer.concat([
      existing.subarray(0, range.start),
      range.start === shebangEnd && suffix.at(0) === 10 ? suffix.subarray(1) : suffix,
    ]);
  }
  return Buffer.concat([
    withoutBlock.subarray(0, shebangEnd),
    block,
    Buffer.from("\n"),
    withoutBlock.subarray(shebangEnd),
  ]);
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null && "code" in error
    ? (error as { code?: unknown }).code
    : undefined;
}

function assertTargetUnchanged(
  path: string,
  expected: Buffer | undefined,
  spec: ManagedHookSpec,
  stat?: Stats,
): void {
  let current: Stats;
  try {
    current = lstatSync(path);
  } catch (error) {
    if (expected === undefined && errorCode(error) === "ENOENT") return;
    throw new Error(`${spec.hookName} hook changed concurrently: ${path}`);
  }
  if (expected === undefined) {
    throw new Error(`${spec.hookName} hook appeared concurrently: ${path}`);
  }
  if (
    !current.isFile() ||
    current.isSymbolicLink() ||
    current.size > MAX_HOOK_BYTES ||
    current.dev !== stat?.dev ||
    current.ino !== stat?.ino ||
    (current.mode & 0o7777) !== ((stat?.mode ?? 0) & 0o7777) ||
    !readHookFile(path).equals(expected)
  ) {
    throw new Error(`${spec.hookName} hook changed concurrently: ${path}`);
  }
}

function rewriteHookAtomically(
  path: string,
  next: Buffer,
  expected: Buffer | undefined,
  spec: ManagedHookSpec,
  stat?: Stats,
): void {
  const parent = dirname(path);
  mkdirSync(parent, { recursive: true });
  const temporary = resolve(
    parent,
    `.${basename(path)}.prim-${String(process.pid)}-${randomUUID()}.tmp`,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      stat?.mode ?? 0o755,
    );
    writeFileSync(fd, next);
    fchmodSync(fd, (stat?.mode ?? 0o755) & 0o7777);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    // The same-directory rename is atomic; this last-moment identity+content
    // guard prevents a concurrent editor from being silently overwritten.
    assertTargetUnchanged(path, expected, spec, stat);
    renameSync(temporary, path);
  } finally {
    if (fd !== undefined) {
      try {
        closeSync(fd);
      } catch {
        // Best-effort cleanup after a failed write.
      }
    }
    try {
      unlinkSync(temporary);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") {
        // The target was already committed or remains untouched. A failed temp
        // cleanup must not trigger a second write or unlink the target.
      }
    }
  }
}

function unlinkHookUnchanged(
  path: string,
  expected: Buffer,
  stat: Stats,
  spec: ManagedHookSpec,
): void {
  assertTargetUnchanged(path, expected, spec, stat);
  unlinkSync(path);
}

/** Merge or refresh only Prim's marked block, preserving every foreign byte. */
export function ensureEffectivePostCommitHook(cwd: string = process.cwd()): {
  path: string;
  changed: boolean;
  kind: EffectivePostCommitHook["kind"];
} {
  const target = resolveEffectivePostCommitHook(cwd);
  return ensureTarget(target, POST_COMMIT_MANAGED_HOOK);
}

export function ensureEffectivePostRewriteHook(cwd: string = process.cwd()): {
  path: string;
  changed: boolean;
  kind: EffectivePostRewriteHook["kind"];
} {
  const target = resolveEffectivePostRewriteHook(cwd);
  return ensureTarget(target, POST_REWRITE_MANAGED_HOOK);
}

function ensureTarget(
  target: EffectiveManagedHook,
  spec: ManagedHookSpec,
  initialContent?: string,
): {
  path: string;
  changed: boolean;
  kind: EffectiveManagedHook["kind"];
} {
  assertUsableHuskyDispatcher(target, spec);
  const stat = assertSafeFile(target.hookPath, spec);
  if (stat && target.kind === "direct" && (stat.mode & 0o100) === 0) {
    throw new Error(`existing ${spec.hookName} hook is not executable: ${target.hookPath}`);
  }
  const existing = stat ? readHookFile(target.hookPath) : undefined;
  const next =
    !existing && initialContent !== undefined
      ? Buffer.from(initialContent)
      : mergedContent(existing, target.kind === "husky_v9", spec);
  if (!existing && initialContent !== undefined) {
    const shebangEnd = shellInsertionPoint(next, target.kind === "husky_v9", spec);
    const range = blockRange(next, spec);
    if (range.kind !== "current" || range.start !== shebangEnd) {
      throw new Error(`invalid initial Prim ${spec.hookName} scaffold`);
    }
  }
  const contentChanged = !existing || !next.equals(existing);
  if (contentChanged) {
    rewriteHookAtomically(target.hookPath, next, existing, spec, stat);
  }
  return { path: target.hookPath, changed: contentChanged || !stat, kind: target.kind };
}

/** Merge into an explicitly configured foreign hooksPath without resolving Git. */
export function ensurePostCommitHookAtPath(
  hookPath: string,
  initialContent?: string,
): {
  path: string;
  changed: boolean;
  kind: "direct";
} {
  const absolute = resolve(hookPath);
  const result = ensureTarget(
    {
      gitRoot: dirname(dirname(absolute)),
      hooksDir: dirname(absolute),
      hookPath: absolute,
      kind: "direct",
    },
    POST_COMMIT_MANAGED_HOOK,
    initialContent,
  );
  return { ...result, kind: "direct" };
}

export function ensurePostRewriteHookAtPath(
  hookPath: string,
  initialContent?: string,
): {
  path: string;
  changed: boolean;
  kind: "direct";
} {
  const absolute = resolve(hookPath);
  const result = ensureTarget(
    {
      gitRoot: dirname(dirname(absolute)),
      hooksDir: dirname(absolute),
      hookPath: absolute,
      kind: "direct",
    },
    POST_REWRITE_MANAGED_HOOK,
    initialContent,
  );
  return { ...result, kind: "direct" };
}

/** Read-only effective coverage check used by doctor and setup verification. */
export function inspectEffectivePostCommitHook(
  cwd: string = process.cwd(),
): PostCommitHookInspection {
  return inspectEffectiveManagedHook(POST_COMMIT_MANAGED_HOOK, cwd);
}

export function inspectEffectivePostRewriteHook(
  cwd: string = process.cwd(),
): PostRewriteHookInspection {
  return inspectEffectiveManagedHook(POST_REWRITE_MANAGED_HOOK, cwd);
}

function inspectEffectiveManagedHook(spec: ManagedHookSpec, cwd: string): ManagedHookInspection {
  const target = resolveEffectiveManagedHook(spec, cwd);
  try {
    assertUsableHuskyDispatcher(target, spec);
  } catch (error) {
    const missing =
      error instanceof Error &&
      (error.message.includes("missing or not executable") || error.message.includes("unsafe"));
    return {
      ...target,
      covered: false,
      executable: false,
      current: false,
      reason: missing ? "husky_dispatcher_missing" : "husky_dispatcher_invalid",
    };
  }
  let stat: Stats | undefined;
  try {
    stat = assertSafeFile(target.hookPath, spec);
  } catch {
    return {
      ...target,
      covered: false,
      executable: false,
      current: false,
      reason: "unsafe_target",
    };
  }
  if (!stat) {
    return {
      ...target,
      covered: false,
      executable: false,
      current: false,
      reason: "missing",
    };
  }
  // Husky invokes its public script through the executable generated
  // dispatcher (`sh ../<hook>`), so a tracked 100644 public file is valid.
  const executable = target.kind === "husky_v9" || (stat.mode & 0o100) !== 0;
  try {
    const content = readHookFile(target.hookPath);
    const shebangEnd = shellInsertionPoint(content, target.kind === "husky_v9", spec);
    const range = blockRange(content, spec);
    const positioned = range.kind !== "absent" && range.start === shebangEnd;
    const current = range.kind === "current" && positioned;
    return {
      ...target,
      covered: current && executable,
      executable,
      current,
      reason:
        range.kind === "current" && !positioned
          ? "unreachable_block"
          : !current
            ? "stale_block"
            : executable
              ? undefined
              : "not_executable",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    const reason: ManagedHookInspection["reason"] = message.includes("binary")
      ? "binary"
      : message.includes("unsupported")
        ? "unsupported_interpreter"
        : "malformed_markers";
    return {
      ...target,
      covered: false,
      executable,
      current: false,
      reason,
    };
  }
}

/** Remove only Prim's block, deleting the file only when Prim created it. */
export function uninstallEffectivePostCommitHook(cwd: string = process.cwd()): {
  path: string;
  changed: boolean;
  removedFile: boolean;
} {
  const target = resolveEffectivePostCommitHook(cwd);
  return uninstallTarget(target, POST_COMMIT_MANAGED_HOOK);
}

export function uninstallEffectivePostRewriteHook(cwd: string = process.cwd()): {
  path: string;
  changed: boolean;
  removedFile: boolean;
} {
  const target = resolveEffectivePostRewriteHook(cwd);
  return uninstallTarget(target, POST_REWRITE_MANAGED_HOOK);
}

function projectHooksPathIsConfigured(gitRoot: string): boolean {
  for (const scope of ["--worktree", "--local"]) {
    try {
      const value = execFileSync("git", ["config", scope, "--get", "core.hooksPath"], {
        cwd: gitRoot,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
      }).trim();
      if (value.length > 0) return true;
    } catch {
      // An unset scope (or worktree config disabled) is not project-owned.
    }
  }
  return false;
}

/**
 * Remove only this checkout's post-commit installation.
 *
 * An inherited global/system core.hooksPath is shared by every repository and
 * must be left to `hooks uninstall --scope user`. Its dispatcher chains to the
 * repository's common .git/hooks directory, which is the project artifact a
 * migration should remove.
 */
export function uninstallProjectPostCommitHook(cwd: string = process.cwd()): {
  path: string;
  changed: boolean;
  removedFile: boolean;
} {
  const gitRoot = gitToplevel(cwd);
  if (!gitRoot) throw new Error("not a git repository");
  if (projectHooksPathIsConfigured(gitRoot)) {
    return uninstallEffectivePostCommitHook(gitRoot);
  }
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
  }).replace(/\r?\n$/u, "");
  return uninstallPostCommitHookAtPath(
    resolve(safeGitPath(gitRoot, commonDir), "hooks", "post-commit"),
  );
}

export function uninstallProjectPostRewriteHook(cwd: string = process.cwd()): {
  path: string;
  changed: boolean;
  removedFile: boolean;
} {
  const gitRoot = gitToplevel(cwd);
  if (!gitRoot) throw new Error("not a git repository");
  if (projectHooksPathIsConfigured(gitRoot)) {
    return uninstallEffectivePostRewriteHook(gitRoot);
  }
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
  }).replace(/\r?\n$/u, "");
  return uninstallPostRewriteHookAtPath(
    resolve(safeGitPath(gitRoot, commonDir), "hooks", POST_REWRITE_MANAGED_HOOK.hookName),
  );
}

function uninstallTarget(
  target: EffectiveManagedHook,
  spec: ManagedHookSpec,
): {
  path: string;
  changed: boolean;
  removedFile: boolean;
} {
  const stat = assertSafeFile(target.hookPath, spec);
  if (!stat) return { path: target.hookPath, changed: false, removedFile: false };
  const existing = readHookFile(target.hookPath);
  const range = blockRange(existing, spec);
  if (range.kind === "absent") {
    if (
      spec.hookName === POST_COMMIT_MANAGED_HOOK.hookName &&
      existing.toString("utf8").startsWith(`#!/bin/sh\n${LEGACY_PRIM_OWNED_HEADER}\n`)
    ) {
      const prefixLength = legacyProjectPrefixLength(existing);
      if (prefixLength === undefined) {
        throw new Error("unrecognized legacy Prim post-commit invocation");
      }
      const tail = existing.subarray(prefixLength);
      if (tail.length === 0) {
        unlinkHookUnchanged(target.hookPath, existing, stat, spec);
        return { path: target.hookPath, changed: true, removedFile: true };
      }
      rewriteHookAtomically(
        target.hookPath,
        Buffer.concat([Buffer.from("#!/bin/sh\n"), tail]),
        existing,
        spec,
        stat,
      );
      return { path: target.hookPath, changed: true, removedFile: false };
    }
    return { path: target.hookPath, changed: false, removedFile: false };
  }
  const shebangEnd = shellInsertionPoint(existing, target.kind === "husky_v9", spec);
  const suffix = existing.subarray(range.end);
  const createdSuffix = Buffer.from(`\n# ${spec.createdMark}\n`);
  if (
    range.start === shebangEnd &&
    suffix.subarray(0, createdSuffix.length).equals(createdSuffix)
  ) {
    const tail = suffix.subarray(createdSuffix.length);
    if (tail.length === 0) {
      unlinkHookUnchanged(target.hookPath, existing, stat, spec);
      return { path: target.hookPath, changed: true, removedFile: true };
    }
    rewriteHookAtomically(
      target.hookPath,
      Buffer.concat([existing.subarray(0, shebangEnd), tail]),
      existing,
      spec,
      stat,
    );
    return { path: target.hookPath, changed: true, removedFile: false };
  }
  const createdPrefixes = [
    Buffer.from(`#!/bin/sh\n# ${spec.createdMark}\n\n`),
    ...(spec.hookName === POST_COMMIT_MANAGED_HOOK.hookName
      ? [Buffer.from(`#!/bin/sh\n# ${LEGACY_PRIM_CREATED_MARK}\n\n`)]
      : []),
  ];
  const createdPrefix = createdPrefixes.find(
    (prefix) => range.start === prefix.length && existing.subarray(0, prefix.length).equals(prefix),
  );
  if (createdPrefix) {
    const tail = suffix.at(0) === 10 ? suffix.subarray(1) : suffix;
    if (tail.length === 0) {
      unlinkHookUnchanged(target.hookPath, existing, stat, spec);
      return { path: target.hookPath, changed: true, removedFile: true };
    }
    rewriteHookAtomically(
      target.hookPath,
      Buffer.concat([Buffer.from("#!/bin/sh\n"), tail]),
      existing,
      spec,
      stat,
    );
    return { path: target.hookPath, changed: true, removedFile: false };
  }
  const next = Buffer.concat([
    existing.subarray(0, range.start),
    range.start === shebangEnd && suffix.at(0) === 10 ? suffix.subarray(1) : suffix,
  ]);
  rewriteHookAtomically(target.hookPath, next, existing, spec, stat);
  return { path: target.hookPath, changed: true, removedFile: false };
}

export function uninstallPostCommitHookAtPath(hookPath: string): {
  path: string;
  changed: boolean;
  removedFile: boolean;
} {
  const absolute = resolve(hookPath);
  return uninstallTarget(
    {
      gitRoot: dirname(dirname(absolute)),
      hooksDir: dirname(absolute),
      hookPath: absolute,
      kind: "direct",
    },
    POST_COMMIT_MANAGED_HOOK,
  );
}

export function uninstallPostRewriteHookAtPath(hookPath: string): {
  path: string;
  changed: boolean;
  removedFile: boolean;
} {
  const absolute = resolve(hookPath);
  return uninstallTarget(
    {
      gitRoot: dirname(dirname(absolute)),
      hooksDir: dirname(absolute),
      hookPath: absolute,
      kind: "direct",
    },
    POST_REWRITE_MANAGED_HOOK,
  );
}
