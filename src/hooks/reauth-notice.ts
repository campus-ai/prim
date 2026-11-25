import {
  CLOUD_CREDENTIALS_REMEDY,
  CLOUD_REJECTED_CREDENTIALS_NOTICE,
  isClaudeCloudSession,
} from "../lib/cloud-env.js";
import { hasMachineConfiguration } from "../lib/machine-credentials.js";
import { ENVIRONMENT_CREDENTIAL_REMEDY, sessionIdentityMode } from "../lib/session-identity.js";

/** An organization-shared environment, whose credential an admin minted for everyone. */
function sharedEnvironment(): boolean {
  try {
    return sessionIdentityMode();
  } catch {
    return false;
  }
}
/**
 * The terminal-auth notice surfaced at SessionStart.
 *
 * A terminal-marked OAuth session (isSessionEnded()) captures nothing until the
 * user re-authenticates, and that state is otherwise silent — hooks fail open
 * and the daemon logs only to its own file. SessionStart is the one loud,
 * in-context moment to prompt the fix, so the notice rides Claude Code's
 * `systemMessage`. Codex does not consume this notice: its terminal-auth state
 * renders inside the situation report (`daemon: paused · run \`prim auth
 * login\``) that codex-context.ts delivers on the same SessionStart. Hermes
 * SessionStart hooks are observer-only (no stdout channel consumes a notice),
 * so it returns undefined there and Hermes surfaces re-auth via `prim doctor`
 * / the daemon log instead.
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
  if (agent === "claude_code") {
    // A cloud session has no administrator at hand and cannot sign in: the
    // person who configured the environment fixes it there. The web transcript
    // shows no systemMessage, so the agent must be told to relay it.
    if (isClaudeCloudSession()) {
      const notice = !hasMachineConfiguration()
        ? `Primitive is not connected in this Claude Code cloud session: its sign-in ended. To fix it, ${CLOUD_CREDENTIALS_REMEDY}.`
        : sharedEnvironment()
          ? `Primitive is not connected in this Claude Code cloud session: its environment credential was rejected. To fix it, ${ENVIRONMENT_CREDENTIAL_REMEDY}.`
          : CLOUD_REJECTED_CREDENTIALS_NOTICE;
      return {
        systemMessage: notice,
        additionalContext: `${notice} Tell the user this in one sentence before starting their task.`,
      };
    }
    return {
      systemMessage: hasMachineConfiguration()
        ? "[prim] machine delivery paused; local capture remains saved. Run `prim auth status` and ask your administrator to enable or rotate machine credentials."
        : REAUTH_NOTICE,
    };
  }
  return;
}
