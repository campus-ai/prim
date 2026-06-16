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
 * returns a final verdict plus two fail-closed signals the hook MUST honor —
 * `verdict: "unavailable"` (the lookup did not run, e.g. an org-unbound
 * token) and `truncated: true` (the conflict set was capped, so it is
 * partial). Either one means constraints are UNKNOWN, and the hook must
 * never render an unknown state as a clean allow.
 */

import { isAbsolute, relative, sep } from "node:path";

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
  hookSpecificOutput: {
    hookEventName: "PreToolUse";
    permissionDecision: ClaudePermissionDecision;
    permissionDecisionReason?: string;
    additionalContext?: string;
  };
};

/**
 * Maps the aggregate conflict verdict + per-file results into the Claude
 * Code hook output JSON:
 *   - `deny` → permissionDecision: "deny" + reason (hard block)
 *   - `ask`  → permissionDecision: "ask"  + reason (native dialog)
 *   - `warn`/`allow` → permissionDecision: "allow", with additionalContext
 *     set when there is warn context OR the check was unverified. An
 *     unverified result NEVER yields a bare allow — the additionalContext
 *     carries the "not verified / partial" note so Claude sees it.
 */
export function buildHookOutput(
  aggregate: ConflictVerdict,
  results: ConflictCheckResult[],
): HookOutput {
  if (aggregate === "deny") {
    const reason =
      results
        .filter((r) => r.verdict === "deny")
        .map((r) => r.reason)
        .filter((s) => s.length > 0)
        .join("\n\n") || "[primitive] conflict detected (no detail available)";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    };
  }
  if (aggregate === "ask") {
    const reason =
      results
        .filter((r) => r.verdict === "ask" || r.verdict === "deny")
        .map((r) => r.reason)
        .filter((s) => s.length > 0)
        .join("\n\n") || "[primitive] please confirm this edit";
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    };
  }
  const notes = [
    ...results.map((r) => r.additionalContext).filter((s) => s.length > 0),
    anyUnverified(results) ? unverifiedNote(results) : "",
  ]
    .filter((s) => s.length > 0)
    .join("\n");
  if (notes.length > 0) {
    return {
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

/**
 * Extracts file paths from Claude Code's tool_input payloads. The three
 * tools the hook intercepts have different shapes:
 *   - Edit:      { file_path, old_string, new_string }
 *   - Write:     { file_path, content }
 *   - MultiEdit: { file_path, edits: [{old_string, new_string}, ...] }
 *
 * Returns the unique file paths the hook should check. Empty when the input
 * shape doesn't expose a file path (e.g., a future tool type the hook hasn't
 * been taught about).
 */
const SUPPORTED_TOOLS = new Set(["Edit", "Write", "MultiEdit"]);

export function extractFilePaths(toolName: string, toolInput: unknown): string[] {
  if (!SUPPORTED_TOOLS.has(toolName)) {
    return [];
  }
  if (!toolInput || typeof toolInput !== "object") {
    return [];
  }
  const input = toolInput as Record<string, unknown>;
  if (typeof input.file_path === "string" && input.file_path.length > 0) {
    return [input.file_path];
  }
  return [];
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
