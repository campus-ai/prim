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
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { resolveRepositoryContext } from "../lib/git.js";
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

const CURSOR_EVENT_MAP: Record<string, string> = {
  sessionStart: "SessionStart",
  beforeSubmitPrompt: "UserPromptSubmit",
  preToolUse: "PreToolUse",
  postToolUse: "PostToolUse",
  postToolUseFailure: "PostToolUseFailure",
  afterAgentResponse: "AssistantResponse",
  subagentStop: "SubagentStop",
  stop: "Stop",
  sessionEnd: "SessionEnd",
};

const CURSOR_TOOL_EVENTS = new Set(["PreToolUse", "PostToolUse", "PostToolUseFailure"]);
const CURSOR_LOCAL_ONLY_FIELDS = new Set([
  "conversation_id",
  "generation_id",
  "user_email",
  "account_email",
  "transcript_path",
  "transcript",
  "thought",
  "thoughts",
  "thinking",
  "tool_output",
]);

function requiredId(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`Cursor hook envelope is missing ${field}`);
  }
  return value;
}

function workspaceCandidates(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const roots = value.filter((item): item is string => typeof item === "string" && item.length > 0);
  if (roots.some((root) => !isAbsolute(root))) {
    throw new TypeError("Cursor workspace roots must be absolute");
  }
  return roots;
}

function pathIdentity(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return resolve(path);
  }
}

/** Resolve Cursor's effective tool cwd before any repository canonicalization. */
export function resolveCursorCwd(parsed: Record<string, unknown>): string {
  const roots = workspaceCandidates(parsed.workspace_roots).map(pathIdentity);
  const rootRepositories = roots.map((root) => resolveRepositoryContext(root)?.repoRoot);
  const repositoryRoots = new Set(rootRepositories.filter((root): root is string => !!root));
  if (repositoryRoots.size > 1) {
    throw new TypeError("Cursor hook envelope spans multiple repositories");
  }
  if (roots.length > 1 && rootRepositories.some((root) => root === undefined)) {
    throw new TypeError("Cursor hook envelope has ambiguous workspace roots");
  }
  const expectedRepo = [...repositoryRoots][0];

  const rawCwd = typeof parsed.cwd === "string" && parsed.cwd.length > 0 ? parsed.cwd : undefined;
  if (rawCwd && !isAbsolute(rawCwd)) {
    throw new TypeError("Cursor hook cwd must be absolute");
  }
  const envelopeCwd = rawCwd ? pathIdentity(rawCwd) : undefined;
  const input =
    typeof parsed.tool_input === "object" &&
    parsed.tool_input !== null &&
    !Array.isArray(parsed.tool_input)
      ? (parsed.tool_input as Record<string, unknown>)
      : undefined;
  const rawToolCwd =
    parsed.tool_name === "Shell" && typeof input?.working_directory === "string"
      ? input.working_directory
      : undefined;
  const base = envelopeCwd ?? (roots.length === 1 ? roots[0] : expectedRepo);
  if (rawToolCwd && !isAbsolute(rawToolCwd) && !base) {
    throw new TypeError("relative Cursor tool cwd has no workspace base");
  }
  const toolCwd = rawToolCwd
    ? pathIdentity(isAbsolute(rawToolCwd) ? rawToolCwd : resolve(base as string, rawToolCwd))
    : undefined;
  const selected = toolCwd ?? envelopeCwd ?? (roots.length === 1 ? roots[0] : expectedRepo);
  if (!selected) {
    throw new TypeError("Cursor hook envelope has no unambiguous workspace");
  }

  const selectedRepo = resolveRepositoryContext(selected)?.repoRoot;
  if (expectedRepo && selectedRepo !== expectedRepo) {
    throw new TypeError("Cursor hook cwd conflicts with workspace repository");
  }
  return selected;
}

function normalizeCursorEnvelope(parsed: Record<string, unknown>): Record<string, unknown> {
  const rawEvent = requiredId(parsed.hook_event_name, "hook_event_name");
  const event = CURSOR_EVENT_MAP[rawEvent];
  if (!event) throw new TypeError(`unsupported Cursor hook event: ${rawEvent}`);
  const sessionId = requiredId(parsed.conversation_id, "conversation_id");
  const turnId = requiredId(parsed.generation_id, "generation_id");
  if (parsed.session_id !== undefined && parsed.session_id !== sessionId) {
    throw new TypeError("Cursor conversation_id conflicts with session_id");
  }
  if (parsed.turn_id !== undefined && parsed.turn_id !== turnId) {
    throw new TypeError("Cursor generation_id conflicts with turn_id");
  }
  if (CURSOR_TOOL_EVENTS.has(event)) requiredId(parsed.tool_use_id, "tool_use_id");

  const normalized: Record<string, unknown> = {
    ...Object.fromEntries(
      Object.entries(parsed).filter(([key]) => !CURSOR_LOCAL_ONLY_FIELDS.has(key)),
    ),
    hook_event_name: event,
    session_id: sessionId,
    turn_id: turnId,
    cwd: resolveCursorCwd(parsed),
  };
  if (typeof parsed.tool_output === "string") {
    try {
      normalized.tool_response = JSON.parse(parsed.tool_output) as unknown;
    } catch {
      normalized.tool_response = parsed.tool_output;
    }
  }
  return normalized;
}

/**
 * The parsed envelope with `hook_event_name` mapped to prim's internal
 * vocabulary for Hermes; the same object untouched for Claude Code and
 * complete Codex envelopes. Missing-id Codex tool events receive a stable
 * synthetic tool_use_id. Returns a shallow copy when it changes an envelope
 * so the caller's original is never mutated.
 */
export function normalizeEnvelope(
  parsed: Record<string, unknown>,
  agent: Agent,
): Record<string, unknown> {
  if (agent === "cursor") {
    return normalizeCursorEnvelope(parsed);
  }
  if (agent === "codex") {
    const event = parsed.hook_event_name;
    if (
      (event === "PreToolUse" || event === "PostToolUse") &&
      (typeof parsed.tool_use_id !== "string" || parsed.tool_use_id.length === 0)
    ) {
      // A missing Codex tool_use_id used to make the passive and synchronous
      // post-tool producers invent different random moveIds for the same edit.
      // The stable subset is shared by pre/post envelopes; tool_response and
      // Primitive enrichment are deliberately excluded.
      const stableToolIdentity = JSON.stringify([
        parsed.session_id ?? null,
        parsed.turn_id ?? null,
        parsed.tool_name ?? null,
        parsed.tool_input ?? null,
      ]);
      return {
        ...parsed,
        tool_use_id: `codex:fallback:v1:${createHash("sha256")
          .update(stableToolIdentity)
          .digest("hex")}`,
      };
    }
    return parsed;
  }
  if (agent !== "hermes") {
    return parsed;
  }
  const raw = parsed.hook_event_name;
  if (typeof raw === "string" && raw in HERMES_EVENT_MAP) {
    return { ...parsed, hook_event_name: HERMES_EVENT_MAP[raw] };
  }
  return parsed;
}
