/**
 * Wire prim into the Git hooks a repository actually runs.
 *
 * One engine for pre-commit, post-commit, and post-rewrite. Each hook file
 * receives the frozen v1 block from `git-hook-contract.ts`; every other byte
 * belongs to the user and survives install, refresh, and uninstall.
 *
 * Two rules keep tracked hook files (`.husky/*`, a repo-relative
 * `core.hooksPath`) quiet:
 *
 * - Placement: a new block goes immediately after the shebang, where it runs
 *   before any `exit`/`exec` and reads post-rewrite's stdin first. An existing
 *   block is never moved, except by an explicit install when it sits behind a
 *   top-level `exit`/`exec`/`return` and could never run.
 * - Write context: explicit commands (`prim enable`, `prim hooks install`) may
 *   write a hook file inside the worktree; ambient repair (SessionStart) only
 *   writes hook files outside it, such as `.git/hooks`.
 *
 * `git config prim.gitHooks manual` hands wiring to the user: prim then never
 * writes a hook file, and inspection still reports what it finds.
 */
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
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { commandMatchesBin } from "./bin-path.js";
import {
  GIT_HOOK_CONTRACT_VERSION,
  GIT_HOOK_ENTRYPOINT_NAME,
  MANAGED_GIT_HOOK_NAMES,
  type ManagedGitHookName,
  blockMarkers,
  canonicalHookBlock,
  hookBlockContractVersion,
  managedHookBlock,
} from "./git-hook-contract.js";
import { gitToplevel } from "./git.js";
import { type GitHookEntrypointState, inspectGitHookEntrypoint } from "./hook-runtime.js";

export { MANAGED_GIT_HOOK_NAMES, type ManagedGitHookName, managedHookBlock };

// Provenance marks: a file whose only non-Prim content is one of these was
// created by prim, so uninstall may delete it rather than leave an empty hook.
const LEGACY_PRIM_CREATED_MARK = "prim-created-hook";
const LEGACY_PRIM_OWNED_HEADER =
  "# prim post-commit hook — installed by: prim hooks install (prim-managed-hook)";
const LEGACY_GLOBAL_OWNED_HEADER =
  "# prim global post-commit hook (core.hooksPath) — managed by prim; do not edit.";
const LEGACY_PRE_COMMIT_OWNED_HEADER =
  "# prim pre-commit hook — installed by: prim hooks install (prim-managed-hook)";

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
  hookName: ManagedGitHookName;
  blockStart: string;
  blockEnd: string;
  createdMark: string;
  /** A bin whose bare mention means the user already wired this hook. */
  userWiredBin?: string;
};

function managedHookSpecFor(hookName: ManagedGitHookName): ManagedHookSpec {
  const { start, end } = blockMarkers(hookName);
  return {
    hookName,
    blockStart: start,
    blockEnd: end,
    createdMark: `prim-created-${hookName}-hook`,
    ...(hookName === "pre-commit" ? { userWiredBin: "prim-pre-commit" } : {}),
  };
}

const MANAGED_HOOK_SPECS: Record<ManagedGitHookName, ManagedHookSpec> = {
  "pre-commit": managedHookSpecFor("pre-commit"),
  "post-commit": managedHookSpecFor("post-commit"),
  "post-rewrite": managedHookSpecFor("post-rewrite"),
};

export function managedHookSpec(hookName: ManagedGitHookName): ManagedHookSpec {
  return MANAGED_HOOK_SPECS[hookName];
}

/** Who may write hook files: the user's own command, or background repair. */
export type HookWriteContext = "explicit" | "ambient";

/** `prim.gitHooks`: `manual` means the user wires prim's hooks themselves. */
export type GitHooksMode = "auto" | "manual";

export type EffectiveManagedHook = {
  gitRoot: string;
  hooksDir: string;
  hookPath: string;
  kind: "direct" | "husky_v9";
  /** Husky's generated dispatcher. Prim observes it but never writes it. */
  dispatcherPath?: string;
  /** Inside the working tree (so possibly tracked), not under `.git`. */
  inWorktree: boolean;
};

export type ManagedHookInspection = EffectiveManagedHook & {
  hookName: ManagedGitHookName;
  /** Configuration, reported beside health rather than as a failure. */
  mode: GitHooksMode;
  covered: boolean;
  executable: boolean;
  current: boolean;
  /** How the hook reaches prim: prim's block, or the user's own call. */
  wiring?: "block" | "user";
  entrypoint: GitHookEntrypointState;
  reason?:
    | "missing"
    | "binary"
    | "malformed_markers"
    | "unsafe_target"
    | "missing_block"
    | "stale_block"
    | "unreachable_block"
    | "husky_dispatcher_missing"
    | "husky_dispatcher_invalid"
    | "unsupported_interpreter"
    | "not_executable"
    | "entrypoint_missing";
};

export type EnsureHookResult = {
  hookName: ManagedGitHookName;
  path: string;
  kind: EffectiveManagedHook["kind"];
  changed: boolean;
  /**
   * `deferred`: ambient repair found work in a worktree hook file and left it
   * for an explicit command. `manual`: prim.gitHooks=manual, nothing written.
   */
  outcome: "created" | "updated" | "unchanged" | "deferred" | "manual";
};

export type UninstallHookResult = { path: string; changed: boolean; removedFile: boolean };

/** Read prim.gitHooks from the repository (all scopes) or the global config. */
export function gitHooksMode(options: { cwd?: string; global?: boolean } = {}): GitHooksMode {
  try {
    const value = execFileSync(
      "git",
      ["config", ...(options.global ? ["--global"] : []), "--get", "prim.gitHooks"],
      {
        cwd: options.cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
      },
    ).trim();
    return value === "manual" ? "manual" : "auto";
  } catch {
    return "auto";
  }
}

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
  return Buffer.from(`#!/bin/sh\n${managedHookBlock(spec.hookName)}\n# ${spec.createdMark}\n`);
}

/** Prefixes of scaffolds earlier releases created, block directly after them. */
function oldCreatedPrefixes(spec: ManagedHookSpec): Buffer[] {
  return [
    Buffer.from(`#!/bin/sh\n# ${spec.createdMark}\n\n`),
    Buffer.from(`#!/bin/sh\n# ${LEGACY_PRIM_CREATED_MARK}\n\n`),
  ];
}

/** A pre-commit file an earlier `prim hooks install` wrote and owns entirely. */
export function isOwnedStandalonePreCommit(content: string): boolean {
  if (content === "#!/bin/sh\nprim-pre-commit\n") return true;
  const prefix = `#!/bin/sh\n${LEGACY_PRE_COMMIT_OWNED_HEADER}\n\n`;
  const suffix = "; } || true\n";
  if (!content.startsWith(prefix) || !content.endsWith(suffix)) return false;
  const body = content.slice(prefix.length, -suffix.length);
  if (!body.startsWith("{ ") || /[\r\n]/u.test(body)) return false;
  return commandMatchesBin(body.slice(2), "prim-pre-commit");
}

function isInWorktree(gitRoot: string, hookPath: string): boolean {
  const path = relative(gitRoot, hookPath);
  if (path === "" || isAbsolute(path) || path === ".." || path.startsWith(`..${sep}`)) {
    return false;
  }
  return path.split(sep)[0] !== ".git";
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

/** Resolve the destination Git actually invokes, including worktrees/overrides. */
export function resolveEffectiveGitHook(
  hookName: ManagedGitHookName,
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
    const hookPath = resolve(dirname(hooksDir), hookName);
    return {
      gitRoot,
      hooksDir,
      hookPath,
      kind: "husky_v9",
      dispatcherPath: resolve(hooksDir, hookName),
      inWorktree: isInWorktree(gitRoot, hookPath),
    };
  }
  const hookPath = resolve(hooksDir, hookName);
  return {
    gitRoot,
    hooksDir,
    hookPath,
    kind: "direct",
    inWorktree: isInWorktree(gitRoot, hookPath),
  };
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

type BlockRange =
  | { kind: "absent" }
  | { kind: "current" | "stale" | "newer"; start: number; end: number };

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
  const text = content.subarray(start, end).toString("utf8");
  if (canonicalHookBlock(text) === canonicalHookBlock(managedHookBlock(spec.hookName))) {
    return { kind: "current", start, end };
  }
  // A later contract wrote this block; it is not ours to downgrade.
  const version = hookBlockContractVersion(text);
  if (version !== undefined && version > GIT_HOOK_CONTRACT_VERSION) {
    return { kind: "newer", start, end };
  }
  return { kind: "stale", start, end };
}

/** The user calls prim from this hook themselves, outside any managed block. */
function isUserWired(content: Buffer, spec: ManagedHookSpec): boolean {
  const text = content.toString("utf8");
  return (
    text.includes(GIT_HOOK_ENTRYPOINT_NAME) ||
    (spec.userWiredBin !== undefined && text.includes(spec.userWiredBin))
  );
}

const TERMINAL_LINE_RE = /^(?:exit|return)(?:\s|;|$)/u;
const REDIRECT_OPERATOR_RE = /^[0-9]*(?:<<?|>>?|<&|>&|<>|>\|)$/u;
const REDIRECT_WORD_RE = /^[0-9]*(?:<|>)/u;

/** `exec cmd …` replaces the shell; `exec >log 2>&1` only redirects it. */
function isReplacingExec(line: string): boolean {
  if (!/^exec(?:\s|$)/u.test(line)) return false;
  const words = line.slice(4).trim().split(/\s+/u).filter(Boolean);
  for (let index = 0; index < words.length; index += 1) {
    const word = words[index];
    if (word.startsWith("#")) break;
    if (REDIRECT_OPERATOR_RE.test(word)) {
      index += 1;
      continue;
    }
    if (!REDIRECT_WORD_RE.test(word)) return true;
  }
  return false;
}

/**
 * Whether a top-level `exit`, `return`, or replacing `exec` precedes `offset`.
 * Only unindented lines count: a heuristic for the common hook shapes
 * (pre-commit-framework's `exec`, a trailing `exit 0`) without parsing shell.
 */
function terminatesBefore(content: Buffer, from: number, offset: number): boolean {
  const lines = content.subarray(from, offset).toString("utf8").split("\n");
  return lines.some((line) => TERMINAL_LINE_RE.test(line) || isReplacingExec(line));
}

function withoutRange(content: Buffer, start: number, end: number): Buffer {
  const suffix = content.subarray(end);
  return Buffer.concat([
    content.subarray(0, start),
    suffix.at(0) === 10 ? suffix.subarray(1) : suffix,
  ]);
}

function insertBlock(content: Buffer, at: number, spec: ManagedHookSpec): Buffer {
  return Buffer.concat([
    content.subarray(0, at),
    Buffer.from(managedHookBlock(spec.hookName)),
    Buffer.from("\n"),
    content.subarray(at),
  ]);
}

/** Legacy whole-file forms that prove Prim ownership, migrated wholesale. */
function migratedLegacyContent(
  existing: Buffer,
  allowShebangless: boolean,
  spec: ManagedHookSpec,
): Buffer | undefined {
  const text = existing.toString("utf8");
  if (spec.hookName === "pre-commit" && isOwnedStandalonePreCommit(text)) {
    return createdScaffold(spec);
  }
  if (spec.hookName !== "post-commit") return undefined;
  if (text.startsWith(`#!/bin/sh\n${LEGACY_GLOBAL_OWNED_HEADER}\n`)) {
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
    return insertBlock(
      withoutLegacyGate,
      shellInsertionPoint(withoutLegacyGate, allowShebangless, spec),
      spec,
    );
  }
  if (text.startsWith(`#!/bin/sh\n${LEGACY_PRIM_OWNED_HEADER}\n`)) {
    const prefixLength = legacyProjectPrefixLength(existing);
    if (prefixLength === undefined) {
      throw new Error("unrecognized legacy Prim post-commit invocation");
    }
    return Buffer.concat([createdScaffold(spec), existing.subarray(prefixLength)]);
  }
  return undefined;
}

/**
 * The next bytes for a hook file. Returns `existing` itself when nothing should
 * change, so repeated installs are byte-identical.
 */
function mergedContent(
  existing: Buffer | undefined,
  allowShebangless: boolean,
  spec: ManagedHookSpec,
  relocateUnreachable: boolean,
): Buffer {
  if (!existing) return createdScaffold(spec);
  const range = blockRange(existing, spec);
  if (range.kind === "absent") {
    const migrated = migratedLegacyContent(existing, allowShebangless, spec);
    if (migrated) return migrated;
  } else if (range.kind !== "newer") {
    const oldCreated = oldCreatedPrefixes(spec).some(
      (prefix) =>
        range.start === prefix.length && existing.subarray(0, prefix.length).equals(prefix),
    );
    if (oldCreated) {
      const suffix = existing.subarray(range.end);
      const tail = suffix.at(0) === 10 ? suffix.subarray(1) : suffix;
      return Buffer.concat([createdScaffold(spec), tail]);
    }
  }
  const insertion = shellInsertionPoint(existing, allowShebangless, spec);
  switch (range.kind) {
    case "newer":
      return existing;
    case "absent":
      return isUserWired(existing, spec) ? existing : insertBlock(existing, insertion, spec);
    case "current":
    case "stale": {
      const unreachable = terminatesBefore(existing, insertion, range.start);
      if (relocateUnreachable && unreachable) {
        return insertBlock(withoutRange(existing, range.start, range.end), insertion, spec);
      }
      if (range.kind === "current") return existing;
      // Refresh a pre-v1 block where it stands: never move a block for churn.
      return Buffer.concat([
        existing.subarray(0, range.start),
        Buffer.from(managedHookBlock(spec.hookName)),
        existing.subarray(range.end),
      ]);
    }
  }
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

function ensureTarget(
  target: EffectiveManagedHook,
  spec: ManagedHookSpec,
  context: HookWriteContext,
): EnsureHookResult {
  assertUsableHuskyDispatcher(target, spec);
  const stat = assertSafeFile(target.hookPath, spec);
  if (stat && target.kind === "direct" && (stat.mode & 0o100) === 0) {
    throw new Error(`existing ${spec.hookName} hook is not executable: ${target.hookPath}`);
  }
  const existing = stat ? readHookFile(target.hookPath) : undefined;
  const next = mergedContent(existing, target.kind === "husky_v9", spec, context === "explicit");
  const result = { hookName: spec.hookName, path: target.hookPath, kind: target.kind };
  if (existing && next.equals(existing)) {
    return { ...result, changed: false, outcome: "unchanged" };
  }
  if (context === "ambient" && target.inWorktree) {
    return { ...result, changed: false, outcome: "deferred" };
  }
  rewriteHookAtomically(target.hookPath, next, existing, spec, stat);
  return { ...result, changed: true, outcome: existing ? "updated" : "created" };
}

/**
 * Wire one managed hook where Git runs it for this repository. Ambient callers
 * never write a hook file inside the worktree; manual mode never writes.
 */
export function ensureEffectiveGitHook(
  hookName: ManagedGitHookName,
  cwd: string = process.cwd(),
  options: { context?: HookWriteContext } = {},
): EnsureHookResult {
  const target = resolveEffectiveGitHook(hookName, cwd);
  if (gitHooksMode({ cwd: target.gitRoot }) === "manual") {
    return {
      hookName,
      path: target.hookPath,
      kind: target.kind,
      changed: false,
      outcome: "manual",
    };
  }
  return ensureTarget(target, managedHookSpec(hookName), options.context ?? "explicit");
}

function explicitTarget(hookPath: string, options: { husky?: boolean }): EffectiveManagedHook {
  const absolute = resolve(hookPath);
  return {
    gitRoot: dirname(dirname(absolute)),
    hooksDir: dirname(absolute),
    hookPath: absolute,
    // A `.husky/<hook>` file is run by Husky's dispatcher via `sh`, so it needs
    // neither a shebang nor the executable bit.
    kind: options.husky ? "husky_v9" : "direct",
    inWorktree: false,
  };
}

/** Wire one managed hook into an explicitly chosen file (an explicit write). */
export function ensureGitHookAtPath(
  hookName: ManagedGitHookName,
  hookPath: string,
  options: { husky?: boolean } = {},
): EnsureHookResult {
  return ensureTarget(explicitTarget(hookPath, options), managedHookSpec(hookName), "explicit");
}

/** Read-only effective coverage check used by doctor and setup verification. */
export function inspectEffectiveGitHook(
  hookName: ManagedGitHookName,
  cwd: string = process.cwd(),
): ManagedHookInspection {
  const spec = managedHookSpec(hookName);
  const target = resolveEffectiveGitHook(hookName, cwd);
  const base = {
    ...target,
    hookName,
    mode: gitHooksMode({ cwd: target.gitRoot }),
    entrypoint: inspectGitHookEntrypoint(),
  };
  const uncovered = (
    reason: ManagedHookInspection["reason"],
    executable = false,
  ): ManagedHookInspection => ({ ...base, covered: false, executable, current: false, reason });
  try {
    assertUsableHuskyDispatcher(target, spec);
  } catch (error) {
    const missing =
      error instanceof Error &&
      (error.message.includes("missing or not executable") || error.message.includes("unsafe"));
    return uncovered(missing ? "husky_dispatcher_missing" : "husky_dispatcher_invalid");
  }
  let stat: Stats | undefined;
  try {
    stat = assertSafeFile(target.hookPath, spec);
  } catch {
    return uncovered("unsafe_target");
  }
  if (!stat) return uncovered("missing");
  // Husky invokes its public script through the executable generated
  // dispatcher (`sh ../<hook>`), so a tracked 100644 public file is valid.
  const executable = target.kind === "husky_v9" || (stat.mode & 0o100) !== 0;
  let range: BlockRange;
  let content: Buffer;
  let insertion: number;
  try {
    content = readHookFile(target.hookPath);
    insertion = shellInsertionPoint(content, target.kind === "husky_v9", spec);
    range = blockRange(content, spec);
  } catch (error) {
    const message = error instanceof Error ? error.message : "";
    return uncovered(
      message.includes("binary")
        ? "binary"
        : message.includes("unsupported")
          ? "unsupported_interpreter"
          : "malformed_markers",
      executable,
    );
  }
  const userWired = range.kind === "absent" && isUserWired(content, spec);
  const current = range.kind === "current" || range.kind === "newer" || userWired;
  const reason: ManagedHookInspection["reason"] =
    range.kind === "absent" && !userWired
      ? "missing_block"
      : range.kind === "stale"
        ? "stale_block"
        : range.kind !== "absent" && terminatesBefore(content, insertion, range.start)
          ? "unreachable_block"
          : !executable
            ? "not_executable"
            : base.entrypoint !== "ready"
              ? "entrypoint_missing"
              : undefined;
  return {
    ...base,
    covered: reason === undefined,
    executable,
    current,
    ...(current ? { wiring: userWired ? ("user" as const) : ("block" as const) } : {}),
    ...(reason ? { reason } : {}),
  };
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

/** Remove only Prim's block, deleting the file only when Prim created it. */
export function uninstallEffectiveGitHook(
  hookName: ManagedGitHookName,
  cwd: string = process.cwd(),
): UninstallHookResult {
  return uninstallTarget(resolveEffectiveGitHook(hookName, cwd), managedHookSpec(hookName));
}

/**
 * Remove only this checkout's installation of one hook.
 *
 * An inherited global/system core.hooksPath is shared by every repository and
 * must be left to `hooks uninstall --scope user`. Its dispatcher chains to the
 * repository's common .git/hooks directory, which is the project artifact a
 * migration should remove.
 */
export function uninstallProjectGitHook(
  hookName: ManagedGitHookName,
  cwd: string = process.cwd(),
): UninstallHookResult {
  const gitRoot = gitToplevel(cwd);
  if (!gitRoot) throw new Error("not a git repository");
  if (projectHooksPathIsConfigured(gitRoot)) {
    return uninstallEffectiveGitHook(hookName, gitRoot);
  }
  return uninstallGitHookAtPath(hookName, resolve(projectHooksDir(gitRoot), hookName));
}

/**
 * Resolve the repository-owned hooks directory without following
 * core.hooksPath. In a linked worktree `<root>/.git` is a file, while Git's
 * common directory still owns the hooks that project scope manages.
 */
export function projectHooksDir(gitRoot: string): string {
  const commonDir = execFileSync("git", ["rev-parse", "--git-common-dir"], {
    cwd: gitRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
    timeout: GIT_TIMEOUT_MS,
  }).replace(/\r?\n$/u, "");
  return resolve(safeGitPath(gitRoot, commonDir), "hooks");
}

export function uninstallGitHookAtPath(
  hookName: ManagedGitHookName,
  hookPath: string,
  options: { husky?: boolean } = {},
): UninstallHookResult {
  return uninstallTarget(explicitTarget(hookPath, options), managedHookSpec(hookName));
}

function uninstallTarget(target: EffectiveManagedHook, spec: ManagedHookSpec): UninstallHookResult {
  const unchanged = { path: target.hookPath, changed: false, removedFile: false };
  const stat = assertSafeFile(target.hookPath, spec);
  if (!stat) return unchanged;
  const existing = readHookFile(target.hookPath);
  const remove = (): UninstallHookResult => {
    unlinkHookUnchanged(target.hookPath, existing, stat, spec);
    return { path: target.hookPath, changed: true, removedFile: true };
  };
  const rewrite = (next: Buffer): UninstallHookResult => {
    rewriteHookAtomically(target.hookPath, next, existing, spec, stat);
    return { path: target.hookPath, changed: true, removedFile: false };
  };
  const range = blockRange(existing, spec);
  if (range.kind === "absent") {
    const text = existing.toString("utf8");
    if (spec.hookName === "pre-commit" && isOwnedStandalonePreCommit(text)) return remove();
    if (
      spec.hookName === "post-commit" &&
      text.startsWith(`#!/bin/sh\n${LEGACY_PRIM_OWNED_HEADER}\n`)
    ) {
      const prefixLength = legacyProjectPrefixLength(existing);
      if (prefixLength === undefined) {
        throw new Error("unrecognized legacy Prim post-commit invocation");
      }
      const tail = existing.subarray(prefixLength);
      return tail.length === 0
        ? remove()
        : rewrite(Buffer.concat([Buffer.from("#!/bin/sh\n"), tail]));
    }
    return unchanged;
  }
  const shebangEnd = shellInsertionPoint(existing, target.kind === "husky_v9", spec);
  const suffix = existing.subarray(range.end);
  const createdSuffix = Buffer.from(`\n# ${spec.createdMark}\n`);
  if (
    range.start === shebangEnd &&
    suffix.subarray(0, createdSuffix.length).equals(createdSuffix)
  ) {
    const tail = suffix.subarray(createdSuffix.length);
    return tail.length === 0
      ? remove()
      : rewrite(Buffer.concat([existing.subarray(0, shebangEnd), tail]));
  }
  const createdPrefix = oldCreatedPrefixes(spec).find(
    (prefix) => range.start === prefix.length && existing.subarray(0, prefix.length).equals(prefix),
  );
  if (createdPrefix) {
    const tail = suffix.at(0) === 10 ? suffix.subarray(1) : suffix;
    return tail.length === 0
      ? remove()
      : rewrite(Buffer.concat([Buffer.from("#!/bin/sh\n"), tail]));
  }
  return rewrite(withoutRange(existing, range.start, range.end));
}
