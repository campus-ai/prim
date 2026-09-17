import {
  type CursorEvent,
  cursorHooksPath,
  hasExactCursorHandler,
  readCursorHooks,
} from "../commands/cursor-install.js";
import { resolveRepositoryContext } from "../lib/git.js";

const CURSOR_EVENTS = new Set<CursorEvent>([
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "afterAgentResponse",
  "subagentStop",
  "stop",
  "sessionEnd",
]);

function cursorEvidence(parsed: Record<string, unknown>): parsed is Record<string, unknown> & {
  hook_event_name: CursorEvent;
} {
  return (
    typeof parsed.cursor_version === "string" &&
    parsed.cursor_version.length > 0 &&
    typeof parsed.conversation_id === "string" &&
    parsed.conversation_id.length > 0 &&
    typeof parsed.generation_id === "string" &&
    parsed.generation_id.length > 0 &&
    Array.isArray(parsed.workspace_roots) &&
    typeof parsed.hook_event_name === "string" &&
    CURSOR_EVENTS.has(parsed.hook_event_name as CursorEvent)
  );
}

function uniqueProjectRoot(parsed: Record<string, unknown>): string | undefined {
  if (!Array.isArray(parsed.workspace_roots)) return;
  const roots = new Set(
    parsed.workspace_roots
      .filter((value): value is string => typeof value === "string" && value.length > 0)
      .map((value) => resolveRepositoryContext(value)?.repoRoot)
      .filter((value): value is string => !!value),
  );
  return roots.size === 1 ? [...roots][0] : undefined;
}

/** Suppress an imported Claude handler only when an exact native Cursor peer exists. */
export function shouldSuppressImportedCursorHandler(
  parsed: Record<string, unknown>,
  bin: string,
): boolean {
  if (!cursorEvidence(parsed)) return false;
  const project = uniqueProjectRoot(parsed);
  if (project) {
    try {
      if (
        hasExactCursorHandler(
          readCursorHooks(cursorHooksPath("project", project)),
          parsed.hook_event_name,
          bin,
          "project",
        )
      ) {
        return true;
      }
    } catch {
      // Invalid native config is not evidence that Cursor will execute it.
    }
  }
  try {
    return hasExactCursorHandler(
      readCursorHooks(cursorHooksPath("user")),
      parsed.hook_event_name,
      bin,
      "user",
    );
  } catch {
    return false;
  }
}
