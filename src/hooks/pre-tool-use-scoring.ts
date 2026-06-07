/**
 * Pure helpers for the prim PreToolUse hook (M3).
 *
 * The hook's job is to translate the server-side conflict-check
 * verdict (`allow` / `warn` / `ask` / `deny`) into Claude Code's
 * `permissionDecision` shape. This module owns the mapping + the
 * file-path extraction from Claude Code's tool-input payloads.
 * Everything here is testable without a live network or stdin.
 */

export type ConflictVerdict = "allow" | "warn" | "ask" | "deny";

export type ClaudePermissionDecision = "allow" | "deny" | "ask" | "defer";

export type ConflictCheckResult = {
  verdict: ConflictVerdict;
  conflicts: unknown[];
  reason: string;
  additionalContext: string;
};

const VERDICT_SEVERITY: Record<ConflictVerdict, number> = {
  allow: 0,
  warn: 1,
  ask: 2,
  deny: 3,
};

/**
 * Aggregate per-file verdicts into one for the whole tool call.
 * MultiEdit sees N file paths; the hook must surface ONE decision to
 * Claude Code, so we pick the most-severe verdict across them. Per-
 * file detail (which files contributed which severity) is still
 * carried into `additionalContext` so Claude has the full picture.
 */
export function aggregateCheckResults(results: ConflictCheckResult[]): ConflictVerdict {
  if (results.length === 0) {
    return "allow";
  }
  let worst: ConflictVerdict = "allow";
  for (const r of results) {
    if (VERDICT_SEVERITY[r.verdict] > VERDICT_SEVERITY[worst]) {
      worst = r.verdict;
    }
  }
  return worst;
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
 * Maps the aggregate conflict verdict + per-file results into the
 * Claude Code hook output JSON. The contract is:
 *   - `allow` → no reason, optional additionalContext for `warn`
 *   - `warn`  → permissionDecision: "allow" + additionalContext set
 *   - `ask`   → permissionDecision: "ask" + reason (native dialog)
 *   - `deny`  → permissionDecision: "deny" + reason (hard block)
 */
export function buildHookOutput(
  aggregate: ConflictVerdict,
  results: ConflictCheckResult[],
): HookOutput {
  // `defer` is in the Claude Code contract but we don't use it — our
  // verdicts always resolve to one of the other three terminal states.
  const additionalContext = results
    .map((r) => r.additionalContext)
    .filter((s) => s.length > 0)
    .join("\n");
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
  if (aggregate === "warn" && additionalContext.length > 0) {
    return {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        additionalContext,
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
 * The silent fail-open output we emit when the hook can't reach the
 * server or the stdin JSON is malformed. Hooks must NEVER block the
 * user on their own infrastructure failures.
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
 * Extracts file paths from Claude Code's tool_input payloads. The
 * three tools the hook intercepts have different shapes:
 *   - Edit:      { file_path, old_string, new_string }
 *   - Write:     { file_path, content }
 *   - MultiEdit: { file_path, edits: [{old_string, new_string}, ...] }
 *
 * Returns the unique file paths the hook should check. Empty when
 * the input shape doesn't expose a file path (e.g., a future tool
 * type the hook hasn't been taught about).
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
 * Bypass / mode flags read from process.env. Centralized here so the
 * hook entry-point reads them through one helper and tests can drive
 * them via mock objects.
 */
export type HookEnv = {
  PRIM_BYPASS?: string;
  PRIM_HOOK_MODE?: string;
  PRIM_HOOK_FANOUT_THRESHOLD?: string;
  PRIM_HOOK_DENY_REVERSIBILITY?: string;
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

const DEFAULT_FAN_OUT_THRESHOLD = 3;

export function readFanOutThreshold(env: HookEnv): number {
  const raw = env.PRIM_HOOK_FANOUT_THRESHOLD;
  if (!raw) {
    return DEFAULT_FAN_OUT_THRESHOLD;
  }
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FAN_OUT_THRESHOLD;
}

export function readDenyReversibility(env: HookEnv): "low" | "high" {
  return env.PRIM_HOOK_DENY_REVERSIBILITY === "high" ? "high" : "low";
}

/**
 * Honors `PRIM_HOOK_MODE=warn` by demoting `ask` and `deny` verdicts
 * to `warn` — the hook still surfaces the conflict to Claude but
 * doesn't actually pause. Useful for the ramp-up period where we
 * want telemetry on what WOULD have blocked without inflicting the
 * block on the user.
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
