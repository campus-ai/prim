/**
 * The terminal-auth notice surfaced at SessionStart.
 *
 * A terminal-marked OAuth session (isSessionEnded()) captures nothing until the
 * user re-authenticates, and that state is otherwise silent — hooks fail open
 * and the daemon logs only to its own file. SessionStart is the one loud,
 * in-context moment to prompt the fix, so the notice rides the agent's
 * SessionStart channel: Codex reads `additionalContext`, Claude Code reads
 * `systemMessage`. Hermes SessionStart hooks are observer-only (no stdout
 * channel consumes a notice), so it returns undefined there and Hermes surfaces
 * re-auth via `prim doctor` / the daemon log instead.
 *
 * Returns buildHookOutput options rather than a finished HookOutput so the
 * caller can compose the notice with other fields (e.g. reloadSkills) in one
 * builder call — hook output shape has exactly one author. Pure so the
 * agent-shaping is unit-pinned without driving the hook's stdin/daemon IO.
 */
import type { Agent } from "./agent.js";

export const REAUTH_NOTICE =
  "[prim] authentication ended — run `prim auth login` to resume decision capture";

export function reauthNoticeFields(
  agent: Agent,
): { systemMessage?: string; additionalContext?: string } | undefined {
  if (agent === "codex") return { additionalContext: REAUTH_NOTICE };
  if (agent === "claude_code") return { systemMessage: REAUTH_NOTICE };
  return;
}
