/**
 * Translate a Hermes shell-hook event envelope into prim's internal
 * (Claude Code) vocabulary, in place at the wire boundary, so every
 * downstream guard (`hook_event_name === "PreToolUse"`,
 * `shouldFlushAfter("SessionEnd")`, …) keeps working unchanged. Claude Code
 * and Codex already speak that vocabulary, so for them this is a no-op.
 *
 * Hermes shell hooks fire under different event names but a stdin schema
 * whose field NAMES (`hook_event_name`, `tool_name`, `tool_input`,
 * `session_id`, `cwd`) coincide with Claude's — only the `hook_event_name`
 * VALUE differs. We remap just that value. Tool names stay native
 * (`write_file` / `patch`), matching the server's per-agent tool awareness.
 */
import type { Agent } from "./agent.js";

// Hermes shell-hook event name → prim's internal Claude Code event name.
// Hermes events with no decision-graph analog (on_session_finalize,
// on_session_reset, pre/post_api_request) are intentionally absent: they map
// to nothing, match no guard, and are captured verbatim.
const HERMES_EVENT_MAP: Record<string, string> = {
  on_session_start: "SessionStart",
  on_session_end: "SessionEnd",
  pre_llm_call: "UserPromptSubmit",
  post_llm_call: "Stop",
  pre_tool_call: "PreToolUse",
  post_tool_call: "PostToolUse",
  subagent_stop: "SubagentStop",
};

/**
 * The parsed envelope with `hook_event_name` mapped to prim's internal
 * vocabulary for Hermes; the same object untouched for Claude Code / Codex
 * (and for any Hermes event with no internal analog). Returns a shallow copy
 * when it remaps so the caller's original is never mutated.
 */
export function normalizeEnvelope(
  parsed: Record<string, unknown>,
  agent: Agent,
): Record<string, unknown> {
  if (agent !== "hermes") {
    return parsed;
  }
  const raw = parsed.hook_event_name;
  if (typeof raw === "string" && raw in HERMES_EVENT_MAP) {
    return { ...parsed, hook_event_name: HERMES_EVENT_MAP[raw] };
  }
  return parsed;
}
