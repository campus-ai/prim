/**
 * Pure helpers for the prim PreToolUse hook.
 *
 * The hook translates the server-side conflict-check verdict into Claude
 * Code's `permissionDecision` shape. This module owns the verdict mapping,
 * the repository-relative path key the server matches on, and the file-path
 * extraction from Claude Code's tool-input payloads. Everything here is
 * testable without a live network or stdin.
 *
 * The server is the sole owner of conflict policy: it scores each file and
 * returns a final verdict plus two uncertainty signals the hook MUST honor —
 * `verdict: "unavailable"` (the lookup did not run, e.g. an org-unbound
 * token) and `truncated: true` (the conflict set was capped, so it is
 * partial). Either one means constraints are UNKNOWN, and the hook must
 * never render an unknown state as a clean allow.
 */

import { isAbsolute, relative, sep } from "node:path";
import type { Agent } from "./agent.js";

export type ConflictVerdict = "allow" | "warn" | "ask" | "deny";

// The four scored verdicts plus the handler-level "unavailable" marker the
// server returns when the lookup could not run (org-unbound token). Kept
// distinct from ConflictVerdict so the severity fold can never index it.
export type ResultVerdict = ConflictVerdict | "unavailable";

export type ClaudePermissionDecision = "allow" | "deny" | "ask";

export type ConflictCheckResult = {
  verdict: ResultVerdict;
  conflicts: unknown[];
  reason: string;
  additionalContext: string;
  truncated: boolean;
  unavailable?: string;
  bypassed?: { decisionId: string; shortId: string | undefined }[];
};

const VERDICT_SEVERITY: Record<ConflictVerdict, number> = {
  allow: 0,
  warn: 1,
  ask: 2,
  deny: 3,
};

/**
 * Translate a file path into the repository-relative, forward-slash join key
 * the server matches on. Claude Code passes `tool_input.file_path` as an
 * absolute path, so relativize it against the session cwd (the same
 * derivation capture uses) and normalize Windows separators — a backslash or
 * absolute path is a hard 400 the hook would otherwise fail open on. A path
 * outside the repo relativizes to a `../…` key the server simply never
 * matches, i.e. a clean pass-through.
 */
export function toRepoRelative(filePath: string, cwd: string): string {
  const rel = isAbsolute(filePath) ? relative(cwd, filePath) : filePath;
  return sep === "/" ? rel : rel.split(sep).join("/");
}

/**
 * Aggregate per-file verdicts into one for the whole tool call. MultiEdit
 * sees N file paths; the hook surfaces ONE decision to Claude Code, so we
 * pick the most-severe scored verdict. An "unavailable" result never
 * escalates severity here — it is handled separately as an unverified signal
 * (see anyUnverified) so it can never collapse into an allow.
 */
export function aggregateCheckResults(results: ConflictCheckResult[]): ConflictVerdict {
  let worst: ConflictVerdict = "allow";
  for (const r of results) {
    if (r.verdict !== "unavailable" && VERDICT_SEVERITY[r.verdict] > VERDICT_SEVERITY[worst]) {
      worst = r.verdict;
    }
  }
  return worst;
}

/**
 * True when any per-file result left the constraint set unknown or partial:
 * an "unavailable" verdict (the lookup did not run) or a truncated conflict
 * list (the server capped it). Either way the hook must not present a clean
 * allow.
 */
export function anyUnverified(results: ConflictCheckResult[]): boolean {
  return results.some((r) => r.verdict === "unavailable" || r.truncated);
}

/**
 * Human-readable note naming WHY the check is unverified, so the allow we
 * emit carries an honest "not fully checked" signal instead of a silent
 * clean pass.
 */
export function unverifiedNote(results: ConflictCheckResult[]): string {
  const causes: string[] = [];
  const unavailable = results.find((r) => r.verdict === "unavailable");
  if (unavailable) {
    causes.push(
      unavailable.unavailable
        ? `decision check skipped — ${unavailable.unavailable}`
        : "decision check skipped — not verified",
    );
  }
  if (results.some((r) => r.truncated)) {
    causes.push("decision check partial — conflict set truncated (per-file cap hit)");
  }
  return causes.map((c) => `[primitive] ${c}`).join("\n");
}

export type HookOutput = {
  systemMessage?: string;
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: ClaudePermissionDecision;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};

export type CodexHookOutput = {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "PreToolUse";
    permissionDecision?: "deny";
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};

function blockingReason(results: ConflictCheckResult[]): string {
  const parts = results
    .filter((result) => result.verdict === "ask" || result.verdict === "deny")
    .flatMap((result) => [result.reason, result.additionalContext])
    .filter((value) => value.length > 0);
  return [...new Set(parts)].join("\n\n") || "[primitive] conflict detected (no detail available)";
}

function advisoryNote(aggregate: ConflictVerdict, results: ConflictCheckResult[]): string {
  const details = results.flatMap((result) => [
    ...(aggregate === "warn" ? [result.reason] : []),
    result.additionalContext,
  ]);
  if (anyUnverified(results)) details.push(unverifiedNote(results));
  return [...new Set(details.filter((value) => value.length > 0))].join("\n\n");
}

/**
 * Maps the aggregate conflict verdict + per-file results into the Claude
 * Code hook output JSON:
 *   - `deny` → permissionDecision: "deny" + reason (hard block)
 *   - `ask`  → permissionDecision: "ask"  + reason (native dialog)
 *   - `warn`/`allow` → permissionDecision: "allow". Warnings include both
 *     model context and a user-visible systemMessage. An unverified result
 *     never yields a bare allow.
 */
export function buildHookOutput(
  aggregate: ConflictVerdict,
  results: ConflictCheckResult[],
): HookOutput {
  if (aggregate === "deny" || aggregate === "ask") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: aggregate,
        permissionDecisionReason: blockingReason(results),
      },
    };
  }
  const notes = advisoryNote(aggregate, results);
  if (notes.length > 0) {
    return {
      systemMessage: notes,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext: notes,
      },
    };
  }
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

/** Render only fields Codex supports for the current outcome. */
export function buildCodexOutput(
  aggregate: ConflictVerdict,
  results: ConflictCheckResult[],
): CodexHookOutput {
  if (aggregate === "deny" || aggregate === "ask") {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: blockingReason(results),
      },
    };
  }
  const notes = advisoryNote(aggregate, results);
  return notes
    ? {
        systemMessage: notes,
        hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: notes },
      }
    : {};
}

/**
 * The silent fail-open output we emit when the hook can't reach the server
 * or the stdin JSON is malformed. Hooks must NEVER block the user on their
 * own infrastructure failures. (This is distinct from a server verdict of
 * "unavailable" / a truncated set, which are surfaced as an honest note via
 * buildHookOutput — never silently allowed.)
 */
export function failOpenOutput(): HookOutput {
  return {
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
    },
  };
}

export function failOpenCodex(): CodexHookOutput {
  return {};
}

/**
 * Hermes shell-hook output for a pre_tool_call. Hermes gating is
 * block-or-allow — there is no soft "ask"/confirm tier and no context channel
 * at tool time — so a block (`{ action: "block", message }`, Hermes'
 * canonical shape) is the only signal and an allow is an empty object.
 */
export type HermesHookOutput = { action?: "block"; message?: string };

/**
 * Maps the aggregate verdict into Hermes' block-or-allow contract. Both
 * `deny` and `ask` become a block: Hermes has no soft-confirm tier, so a
 * decision Claude would raise as an `ask` dialog is here a block whose
 * message carries the reason and the `prim reconcile …` directive (the agent
 * reconciles, then retries). `warn`/`allow` return an empty object; the caller
 * surfaces warnings on stderr and Hermes continues the tool, including for
 * `semantic_uncertain`.
 */
export function buildHermesOutput(
  aggregate: ConflictVerdict,
  results: ConflictCheckResult[],
): HermesHookOutput {
  if (aggregate !== "deny" && aggregate !== "ask") {
    return {};
  }
  const reason = results
    .filter((r) => r.verdict === "deny" || r.verdict === "ask")
    .map((r) => r.reason)
    .filter((s) => s.length > 0)
    .join("\n\n");
  const directive = results
    .map((r) => r.additionalContext)
    .filter((s) => s.length > 0 && s !== reason)
    .join("\n");
  const message =
    [reason, directive].filter((s) => s.length > 0).join("\n\n") ||
    "[primitive] conflict detected (no detail available)";
  return { action: "block", message };
}

/**
 * The silent fail-open for Hermes — an empty object is "no block". Hooks must
 * never block the user on their own infrastructure failures.
 */
export function failOpenHermes(): HermesHookOutput {
  return {};
}

const SUPPORTED_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);

// Codex routes file edits through `apply_patch`, naming each touched file on
// its own envelope line (`*** Update File: path`).
const APPLY_PATCH_FILE_RE = /^\*\*\* (?:Update|Add|Delete) File: (?<path>.+)$/;
// Hermes V4A renames a file with a STANDALONE `*** Move File: <src> -> <dst>`
// directive — no accompanying Update line (see Hermes tools/patch_parser.py),
// so without this both paths would be dropped and a rename of a decision-bearing
// file would slip the gate. Capture BOTH the source (the existing path that may
// carry prior decisions) and the destination.
const MOVE_FILE_RE = /^\*\*\* Move File:\s*(?<src>.+?)\s*->\s*(?<dst>.+?)\s*$/;
const MOVE_TO_RE = /^\*\*\* Move to: (?<dst>.+)$/;
// Split on either line ending: a CRLF patch would otherwise leave a trailing
// \r that the `$`-anchored regex can't match, dropping every file silently.
const LINE_SPLIT_RE = /\r?\n/;
export type FileTargets = { paths: string[]; complete: boolean };
export function parseApplyPatchTargets(command: string): FileTargets {
  const paths = new Set<string>();
  let activeUpdate = false;
  let complete = true;
  for (const line of command.split(LINE_SPLIT_RE)) {
    const path = APPLY_PATCH_FILE_RE.exec(line)?.groups?.path;
    if (path) {
      paths.add(path);
      activeUpdate = line.startsWith("*** Update File:");
      continue;
    }
    const moveTo = MOVE_TO_RE.exec(line)?.groups?.dst;
    if (moveTo) {
      if (activeUpdate) paths.add(moveTo);
      else complete = false;
      activeUpdate = false;
      continue;
    }
    const move = MOVE_FILE_RE.exec(line)?.groups;
    if (move?.src) {
      paths.add(move.src);
      if (move.dst) {
        paths.add(move.dst);
      }
      activeUpdate = false;
      continue;
    }
    if (line === "*** Begin Patch" || line === "*** End Patch") activeUpdate = false;
    else if (line.startsWith("*** ")) complete = false;
  }
  return { paths: [...paths], complete: complete && paths.size > 0 };
}
export const parseApplyPatchPaths = (command: string): string[] =>
  parseApplyPatchTargets(command).paths;
function extractCodexFileTargets(toolName: string, toolInput: unknown): FileTargets | null {
  // `apply_patch` exposes its patch text in Codex's usual `{ command }`
  // envelope, but generic function-tool paths may send a raw string or a
  // differently named string field. Bash is resolved by shell analysis.
  if (toolName !== "apply_patch") {
    return null;
  }
  const text = codexPatchText(toolInput);
  return text !== null ? parseApplyPatchTargets(text) : { paths: [], complete: false };
}
function codexPatchText(toolInput: unknown): string | null {
  if (typeof toolInput === "string") return toolInput;
  if (!toolInput || typeof toolInput !== "object") return null;
  const input = toolInput as Record<string, unknown>;
  for (const key of ["command", "input", "patch"]) {
    const value = input[key];
    if (typeof value === "string") return value;
  }
  return null;
}
// Hermes routes file edits through write_file and patch; terminal and other
// tools pass through unchecked (fail-open). write_file and a `replace` patch
// name a top-level `path`; a `patch`-mode patch embeds a V4A body under
// `patch`, the same grammar Codex's apply_patch uses.
const HERMES_EDITING_TOOLS = new Set(["write_file", "patch"]);
function extractHermesFileTargets(toolName: string, toolInput: unknown): FileTargets | null {
  if (!HERMES_EDITING_TOOLS.has(toolName)) {
    return null;
  }
  if (!toolInput || typeof toolInput !== "object") {
    return { paths: [], complete: false };
  }
  const input = toolInput as Record<string, unknown>;
  if (toolName === "patch" && input.mode === "patch") {
    return typeof input.patch === "string"
      ? parseApplyPatchTargets(input.patch)
      : { paths: [], complete: false };
  }
  const paths = typeof input.path === "string" && input.path.length > 0 ? [input.path] : [];
  const mode = input.mode;
  return { paths, complete: paths.length > 0 && (mode === undefined || mode === "replace") };
}
/**
 * Extracts the file paths a tool call would touch, dispatched by `agent`.
 * Claude Code exposes a single `file_path` on Edit/Write/MultiEdit; Codex
 * routes edits through `apply_patch` with the paths embedded in the patch text.
 * Returns the unique paths to check, empty when the input shape exposes none
 * (fail-open).
 */
export function extractFilePaths(
  toolName: string,
  toolInput: unknown,
  agent: Agent = "claude_code",
): string[] {
  return extractFileTargets(toolName, toolInput, agent)?.paths ?? [];
}
export function extractFileTargets(
  toolName: string,
  toolInput: unknown,
  agent: Agent = "claude_code",
): FileTargets | null {
  if (agent === "codex") {
    return extractCodexFileTargets(toolName, toolInput);
  }
  if (agent === "hermes") {
    return extractHermesFileTargets(toolName, toolInput);
  }
  if (!SUPPORTED_TOOLS.has(toolName)) {
    return null;
  }
  if (!toolInput || typeof toolInput !== "object") {
    return { paths: [], complete: false };
  }
  const input = toolInput as Record<string, unknown>;
  if (toolName === "NotebookEdit") {
    const paths =
      typeof input.notebook_path === "string" && input.notebook_path.length > 0
        ? [input.notebook_path]
        : [];
    return { paths, complete: paths.length > 0 };
  }
  const paths =
    typeof input.file_path === "string" && input.file_path.length > 0 ? [input.file_path] : [];
  return { paths, complete: paths.length > 0 };
}
/**
 * Bypass / mode flags read from process.env. Centralized here so the hook
 * entry-point reads them through one helper and tests can drive them via
 * mock objects. Conflict-scoring thresholds are NOT here — they are 100%
 * server-owned; the hook consumes only the final verdict.
 */
export type HookEnv = {
  PRIM_BYPASS?: string;
  PRIM_HOOK_MODE?: string;
};

export type HookMode = "block" | "warn" | "off";

export function readHookMode(env: HookEnv): HookMode {
  if (env.PRIM_BYPASS === "1" || env.PRIM_BYPASS === "true") {
    return "off";
  }
  const mode = env.PRIM_HOOK_MODE;
  if (mode === "off" || mode === "warn") {
    return mode;
  }
  return "block";
}

/**
 * Honors `PRIM_HOOK_MODE=warn` by demoting `ask` and `deny` verdicts to
 * `warn` — the hook still surfaces the conflict to Claude but doesn't
 * actually pause. Useful for the ramp-up period where we want telemetry on
 * what WOULD have blocked without inflicting the block on the user.
 */
export function demoteForMode(verdict: ConflictVerdict, mode: HookMode): ConflictVerdict {
  if (mode === "off") {
    return "allow";
  }
  if (mode === "warn" && (verdict === "ask" || verdict === "deny")) {
    return "warn";
  }
  return verdict;
}
