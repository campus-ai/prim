import { getSiteUrl, isSessionEnded } from "../client.js";
import { refreshClaudePlugins } from "../commands/claude-plugin.js";
import { daemonRequest } from "../daemon/client.js";
import { kickDaemonEnsure } from "../daemon/self-heal.js";
import {
  FEEDBACK_DEADLINE_MS,
  acknowledgeDecisionFeedback,
  leaseDecisionFeedback,
  renderFeedback,
} from "../decisions/feedback.js";
import { isRepoActiveForCapture } from "../lib/activation.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Agent } from "./agent.js";
import { type HookOutput, buildHookOutput } from "./decision-feedback-core.js";
import { normalizeEnvelope } from "./normalize.js";
import { reauthNoticeFields } from "./reauth-notice.js";

const DAEMON_TIMEOUT_MS = 250;

// Keep this taxonomy in lockstep with the SKILL.md description — the reminder
// and the skill trigger must name the same forks in the road (spec-pinned).
export const PRIM_SKILL_REMINDER =
  "Primitive is active in this repository. When this task chooses between plausible approaches or establishes or changes a lasting goal, priority, constraint, invariant, default, commitment, tradeoff, exception, or shared instruction, invoke the `prim` skill before finishing.";

interface SessionEnvelope {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
}

export interface SessionStartResult {
  output: HookOutput;
  acknowledge?: () => Promise<unknown>;
}

/** Process one already-read SessionStart envelope without owning stdin/stdout. */
export async function processSessionStart(raw: string, agent: Agent): Promise<SessionStartResult> {
  let envelope: SessionEnvelope;
  try {
    envelope = normalizeEnvelope(
      JSON.parse(raw) as Record<string, unknown>,
      agent,
    ) as SessionEnvelope;
  } catch {
    return { output: buildHookOutput({}) };
  }
  if (envelope.hook_event_name !== "SessionStart") {
    return { output: buildHookOutput({}) };
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    return { output: buildHookOutput({}) };
  }

  // Repair or start the supervised daemon once per agent session — kicked
  // first so the detached child runs in parallel with the synchronous skill
  // refresh below. Intentionally detached: hook latency and output must never
  // depend on launchctl or network health, and `daemon ensure` honors an
  // explicit stop.
  kickDaemonEnsure();

  const cwd = envelope.cwd ?? process.cwd();
  let skillState = { installed: 0, refreshed: 0 };
  if (agent === "claude_code") {
    try {
      skillState = refreshClaudePlugins(cwd);
    } catch {
      // SessionStart must remain fail-soft even if refresh regresses.
    }
  }

  await daemonRequest(
    "session_start",
    { sessionId: envelope.session_id },
    { timeoutMs: DAEMON_TIMEOUT_MS },
  );

  // A terminal auth notice remains the only human-facing payload; a silent
  // reload request rides the same builder call when the skill was refreshed.
  if (isSessionEnded()) {
    const notice = reauthNoticeFields(agent);
    if (notice) {
      return {
        output: buildHookOutput({ ...notice, reloadSkills: skillState.refreshed > 0 }),
      };
    }
  }

  // Codex has no statusLine hook, so surface only a fresh live team count. Its
  // SessionStart behavior deliberately does not participate in Claude refresh.
  if (agent === "codex") {
    const snapshot = await daemonRequest<{ onlineCount?: number; presenceStale?: boolean }>(
      "status_snapshot",
      // callerEnv: a cross-env daemon withholds onlineCount, so a prod Codex
      // session never gets a staging daemon's team count injected.
      { callerEnv: getSiteUrl() },
      { timeoutMs: DAEMON_TIMEOUT_MS },
    );
    if (snapshot && !snapshot.presenceStale && typeof snapshot.onlineCount === "number") {
      return {
        output: buildHookOutput({
          additionalContext: `[prim] team: ${snapshot.onlineCount} online`,
        }),
      };
    }
  }

  if (agent === "claude_code") {
    const active = isRepoActiveForCapture(cwd);
    const additionalContext = active && skillState.installed > 0 ? PRIM_SKILL_REMINDER : undefined;
    const reloadSkills = skillState.refreshed > 0;
    if (active) {
      const identity = getOrCreateWorkspaceId(cwd);
      if (identity.status === "ready") {
        const feedbackSignal = AbortSignal.timeout(FEEDBACK_DEADLINE_MS);
        const lease = await leaseDecisionFeedback({
          workspaceId: identity.workspaceId,
          currentSessionId: envelope.session_id,
          signal: feedbackSignal,
        });
        const rendered = lease ? renderFeedback(lease) : undefined;
        return {
          output: buildHookOutput({
            systemMessage: rendered?.systemMessage,
            additionalContext,
            reloadSkills,
          }),
          acknowledge: rendered
            ? async () => {
                await acknowledgeDecisionFeedback({
                  workspaceId: identity.workspaceId,
                  deliveries: rendered.deliveries,
                  signal: feedbackSignal,
                });
              }
            : undefined,
        };
      }
    }
    return { output: buildHookOutput({ additionalContext, reloadSkills }) };
  }

  return { output: buildHookOutput({}) };
}
