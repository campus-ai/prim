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
import { reauthNoticeOutput } from "./reauth-notice.js";

const DAEMON_TIMEOUT_MS = 250;

// Keep this taxonomy in lockstep with the SKILL.md description — the reminder
// and the skill trigger must name the same forks in the road.
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

export interface SessionStartDependencies {
  acknowledgeDecisionFeedback: typeof acknowledgeDecisionFeedback;
  daemonRequest: typeof daemonRequest;
  getOrCreateWorkspaceId: typeof getOrCreateWorkspaceId;
  getSiteUrl: typeof getSiteUrl;
  isRepoActiveForCapture: typeof isRepoActiveForCapture;
  isSessionEnded: typeof isSessionEnded;
  kickDaemonEnsure: typeof kickDaemonEnsure;
  leaseDecisionFeedback: typeof leaseDecisionFeedback;
  normalizeEnvelope: typeof normalizeEnvelope;
  reauthNoticeOutput: typeof reauthNoticeOutput;
  refreshClaudePlugins: typeof refreshClaudePlugins;
  renderFeedback: typeof renderFeedback;
}

const SESSION_START_DEPENDENCIES: SessionStartDependencies = {
  acknowledgeDecisionFeedback,
  daemonRequest,
  getOrCreateWorkspaceId,
  getSiteUrl,
  isRepoActiveForCapture,
  isSessionEnded,
  kickDaemonEnsure,
  leaseDecisionFeedback,
  normalizeEnvelope,
  reauthNoticeOutput,
  refreshClaudePlugins,
  renderFeedback,
};

/** Process one already-read SessionStart envelope without owning stdin/stdout. */
export async function processSessionStart(
  raw: string,
  agent: Agent,
  dependencyOverrides: Partial<SessionStartDependencies> = {},
): Promise<SessionStartResult> {
  const dependencies = { ...SESSION_START_DEPENDENCIES, ...dependencyOverrides };
  let envelope: SessionEnvelope;
  try {
    envelope = dependencies.normalizeEnvelope(
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

  const cwd = envelope.cwd ?? process.cwd();
  let skillState = { installed: 0, refreshed: 0 };
  if (agent === "claude_code") {
    try {
      skillState = dependencies.refreshClaudePlugins(cwd);
    } catch {
      // SessionStart must remain fail-soft even if refresh regresses.
    }
  }

  // Repair or start the supervised daemon once per agent session. This is
  // intentionally detached: hook latency and output must never depend on
  // launchctl or network health, and `daemon ensure` honors an explicit stop.
  dependencies.kickDaemonEnsure();
  await dependencies.daemonRequest(
    "session_start",
    { sessionId: envelope.session_id },
    { timeoutMs: DAEMON_TIMEOUT_MS },
  );

  // A terminal auth notice remains the only human-facing payload. A silent
  // reload request may accompany it when the installed skill was refreshed —
  // grafted onto the notice as-is so no notice field is ever dropped here.
  if (dependencies.isSessionEnded()) {
    const notice = dependencies.reauthNoticeOutput(agent);
    if (notice) {
      if (skillState.refreshed > 0) {
        notice.hookSpecificOutput = {
          hookEventName: "SessionStart",
          ...notice.hookSpecificOutput,
          reloadSkills: true,
        };
      }
      return { output: notice };
    }
  }

  // Codex has no statusLine hook, so surface only a fresh live team count. Its
  // SessionStart behavior deliberately does not participate in Claude refresh.
  if (agent === "codex") {
    const snapshot = await dependencies.daemonRequest<{
      onlineCount?: number;
      presenceStale?: boolean;
    }>(
      "status_snapshot",
      { callerEnv: dependencies.getSiteUrl() },
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
    const active = dependencies.isRepoActiveForCapture(cwd);
    const additionalContext = active && skillState.installed > 0 ? PRIM_SKILL_REMINDER : undefined;
    const reloadSkills = skillState.refreshed > 0 ? true : undefined;
    if (active) {
      const identity = dependencies.getOrCreateWorkspaceId(cwd);
      if (identity.status === "ready") {
        const feedbackSignal = AbortSignal.timeout(FEEDBACK_DEADLINE_MS);
        const lease = await dependencies.leaseDecisionFeedback({
          workspaceId: identity.workspaceId,
          currentSessionId: envelope.session_id,
          signal: feedbackSignal,
        });
        const rendered = lease ? dependencies.renderFeedback(lease) : undefined;
        return {
          output: buildHookOutput({
            systemMessage: rendered?.systemMessage,
            additionalContext,
            reloadSkills,
          }),
          acknowledge: rendered
            ? async () => {
                await dependencies.acknowledgeDecisionFeedback({
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
