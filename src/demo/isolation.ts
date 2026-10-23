import { existsSync } from "node:fs";
import type { Agent } from "../hooks/agent.js";
import { packageVersion } from "../lib/bin-path.js";
import { observeRun } from "./diagnostics.js";
import {
  type DemoAction,
  type DemoChoice,
  type DemoRun,
  RUN_ID,
  demoArgv,
  demoCommand,
  exclusionPath,
  lockRun,
  readRun,
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
  if (envelope.hook_event_name === "PreToolUse") {
    const tool = agent === "cursor" ? "Shell" : agent === "hermes" ? "terminal" : "Bash";
    const input = envelope.tool_input as { command?: unknown; cmd?: unknown } | undefined;
    const command = input?.command ?? input?.cmd;
    if (typeof command === "string" && command.length < 8192) {
      const argv = demoArgv(command);
      // A token in an otherwise malformed command is diagnostic evidence only.
      // Exact argv equality below remains the sole acknowledgment boundary.
      const id = argv?.[4] ?? command.match(/\x27([0-9a-f-]{36})\x27/u)?.[1];
      if (id && RUN_ID.test(id) && existsSync(runPath(id))) {
        const identity =
          typeof session === "string" && session ? sessionKey(agent, session) : undefined;
        const observed = (result: Parameters<typeof observeRun>[1]["result"], errorCode?: string) =>
          observeRun(id, {
            at: Date.now(),
            agent,
            runtimeVersion: packageVersion() ?? undefined,
            session: identity,
            result,
            ...(errorCode ? { errorCode } : {}),
          });
        const action = argv?.[3] as DemoAction;
        const choice = argv?.[6] as DemoChoice | undefined;
        const reason = argv?.[8];
        const recognized = ["start", "attempt", "resolve", "status", "skip"].includes(action);
        const validChoice =
          action !== "resolve" ||
          choice === "adhere" ||
          (choice === "supersede" &&
            typeof reason === "string" &&
            reason.trim().length > 0 &&
            reason.length <= 500);
        const matches = (run: DemoRun) =>
          !run.terminal &&
          recognized &&
          validChoice &&
          demoCommand(run, action, choice, reason) === command;
        // Diagnostics must never make an unrelated/compound shell operation
        // contend on a tour lock or suppress its ordinary capture/enforcement.
        let candidate: DemoRun | undefined;
        try {
          candidate = readRun(id);
        } catch {
          /* No valid run to acknowledge. */
        }
        if (envelope.tool_name !== tool || typeof input?.command !== "string") {
          observed("tool-mismatch");
        } else if (!candidate || !matches(candidate)) {
          observed("command-mismatch");
        } else
          try {
            invocation = lockRun(id, (run) => {
              // Revalidate after locking; recovery may have changed the launcher.
              if (!matches(run)) {
                observed("command-mismatch");
                return false;
              }
              // Skipping before any sample is revealed must not suspend capture.
              if (action === "skip") return true;
              if (!identity) {
                observed("session-missing");
                return false;
              }
              const key = identity;
              if ((run.agent && run.agent !== agent) || (run.binding && run.binding !== key)) {
                observed("session-mismatch");
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
              observed("acknowledged");
              return true;
            });
          } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            observed("write-failed", code && /^[A-Z0-9_]{1,32}$/u.test(code) ? code : undefined);
            throw error;
          }
      }
    }
  }
  return { invocation, excluded: checkExclusion && sessionExcluded(agent, session) };
}
