import { existsSync } from "node:fs";
import type { Agent } from "../hooks/agent.js";
import {
  type DemoAction,
  type DemoChoice,
  demoCommand,
  exclusionPath,
  lockRun,
  runPath,
  saveDemoJson,
  saveRun,
  sessionExcluded,
  sessionKey,
} from "./state.js";

/**
 * Only the exact standalone command emitted by this CLI can acknowledge a
 * run. No shell evaluation, substring allowlist, or session-wide gate bypass.
 * Both capture producers call this before constructing or journaling a Move.
 */
export function observeDemoInvocation(
  envelope: Record<string, unknown>,
  agent: Agent,
  checkExclusion = true,
): { invocation: boolean; excluded: boolean } {
  // Hermes approval-denial events can identify the session only in extra,
  // matching the direct post-tool producer's existing identity fallback.
  const session =
    typeof envelope.session_id === "string" && envelope.session_id
      ? envelope.session_id
      : agent === "hermes"
        ? (envelope.extra as { session_key?: unknown } | undefined)?.session_key
        : undefined;
  let invocation = false;
  if (envelope.hook_event_name === "PreToolUse" && typeof session === "string" && session) {
    const tool = agent === "cursor" ? "Shell" : agent === "hermes" ? "terminal" : "Bash";
    const input = envelope.tool_input as { command?: unknown } | undefined;
    const command = input?.command;
    if (envelope.tool_name === tool && typeof command === "string" && command.length < 8192) {
      const ids = command.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gu,
      );
      if (ids?.length === 1 && existsSync(runPath(ids[0]))) {
        invocation = lockRun(ids[0], (run) => {
          const actions: [DemoAction, DemoChoice?][] = [
            ["start"],
            ["confirm"],
            ["resolve", "repository"],
            ["resolve", "local-storage"],
            ["skip"],
          ];
          const match = actions.find(
            ([action, choice]) => demoCommand(run, action, choice) === command,
          );
          if (run.terminal || !match) {
            return false;
          }
          // Skipping before any sample is revealed must not suspend capture.
          if (match[0] === "skip") return true;
          const key = sessionKey(agent, session);
          if ((run.agent && run.agent !== agent) || (run.binding && run.binding !== key)) {
            run.acknowledgment = undefined;
            saveRun(run);
            return false;
          }
          // Durable exclusion precedes acknowledgment and all sample output.
          saveDemoJson(exclusionPath(key), { runId: run.id });
          run.binding = key;
          run.agent = agent;
          run.acknowledgment = { command, at: Date.now() };
          saveRun(run);
          return true;
        });
      }
    }
  }
  return { invocation, excluded: checkExclusion && sessionExcluded(agent, session) };
}
