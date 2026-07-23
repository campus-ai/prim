import { getSiteUrl, isSessionEnded } from "../client.js";
import { refreshClaudePlugins } from "../commands/claude-plugin.js";
import { hasUsableCodexGuidance } from "../commands/skill.js";
import { daemonRequest } from "../daemon/client.js";
import { kickDaemonEnsure } from "../daemon/self-heal.js";
import {
  FEEDBACK_DEADLINE_MS,
  acknowledgeDecisionFeedback,
  leaseDecisionFeedback,
  renderFeedback,
} from "../decisions/feedback.js";
import { isRepoActiveForCapture } from "../lib/activation.js";
import { gitToplevel } from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Agent } from "./agent.js";
import { type HookOutput, buildHookOutput } from "./decision-feedback-core.js";
import { normalizeEnvelope } from "./normalize.js";
import { reauthNoticeFields } from "./reauth-notice.js";

const DAEMON_TIMEOUT_MS = 250;

// Keep these shared clauses in lockstep with the SKILL.md description. Claude
// and Codex differ only in how they invoke the installed Prim workflow.
const PRIM_TRIGGER =
  "When this task chooses between plausible approaches or establishes or changes a lasting goal, priority, constraint, invariant, default, commitment, tradeoff, exception, or shared instruction";
const PRIM_EXCLUSIONS =
  "Never invoke `prim` for routine implementation that merely follows an existing decision made before this task or for temporary tactics; they never qualify, including for evaluation.";

function primReminder(action: string, rationaleAction: string): string {
  return `Primitive is active in this repository. ${PRIM_TRIGGER}, ${action} before finishing. ${PRIM_EXCLUSIONS} When a direct request replaces one lasting default with another but supplies no rationale, complete the work, ${rationaleAction}, and ask one concise rationale question at the task boundary, even if the user requested only implementation or recording fails.`;
}

export const PRIM_SKILL_REMINDER = primReminder("invoke the `prim` skill", "invoke the skill");

const CODEX_PRIM_ACTION = "follow the installed Prim workflow and use the `prim` CLI";
export const CODEX_PRIM_REMINDER = primReminder(CODEX_PRIM_ACTION, CODEX_PRIM_ACTION);

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
export async function processSessionStart(
  raw: string,
  agent: Agent,
  feedbackSignal: AbortSignal = AbortSignal.timeout(FEEDBACK_DEADLINE_MS),
): Promise<SessionStartResult> {
  let envelope: SessionEnvelope;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return { output: buildHookOutput({}) };
    }
    envelope = normalizeEnvelope(parsed as Record<string, unknown>, agent) as SessionEnvelope;
  } catch {
    return { output: buildHookOutput({}) };
  }
  if (envelope.hook_event_name !== "SessionStart") {
    return { output: buildHookOutput({}) };
  }
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    return { output: buildHookOutput({}) };
  }

  // Repair or start the supervised daemon once per agent session. Intentionally
  // detached: hook latency and output must never depend on launchctl or network
  // health, and `daemon ensure` honors an explicit stop.
  kickDaemonEnsure();

  // Preserve the pre-refresh notification ordering from the original hook:
  // synchronous Git/filesystem work must not delay session presence.
  await daemonRequest(
    "session_start",
    { sessionId: envelope.session_id },
    { timeoutMs: DAEMON_TIMEOUT_MS },
  );

  const cwd = envelope.cwd ?? process.cwd();
  let active = false;
  let skillState = { installed: 0, refreshed: 0 };
  if (agent === "claude_code") {
    try {
      const projectRoot = gitToplevel(cwd);
      active = projectRoot !== null && isRepoActiveForCapture(cwd);
      skillState = await refreshClaudePlugins(
        cwd,
        active && projectRoot !== null
          ? { includeProject: true, projectRoot }
          : { includeProject: false },
      );
    } catch {
      // SessionStart must remain fail-soft even if refresh regresses.
    }
  }

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

  // Codex has no statusLine or live skill-reload field. Supply the proactive
  // trigger as context only when its already-loaded guidance contains Prim.
  if (agent === "codex") {
    const snapshot = await daemonRequest<{ onlineCount?: number; presenceStale?: boolean }>(
      "status_snapshot",
      // callerEnv: a cross-env daemon withholds onlineCount, so a prod Codex
      // session never gets a staging daemon's team count injected.
      { callerEnv: getSiteUrl() },
      { timeoutMs: DAEMON_TIMEOUT_MS },
    );
    const presence =
      snapshot && !snapshot.presenceStale && typeof snapshot.onlineCount === "number"
        ? `[prim] team: ${snapshot.onlineCount} online`
        : undefined;

    let proactive = false;
    try {
      const projectRoot = gitToplevel(cwd);
      proactive =
        projectRoot !== null && isRepoActiveForCapture(cwd) && hasUsableCodexGuidance(projectRoot);
    } catch {
      // Guidance detection must never suppress otherwise-valid presence.
    }
    const additionalContext = [proactive ? CODEX_PRIM_REMINDER : undefined, presence]
      .filter((value): value is string => value !== undefined)
      .join("\n\n");
    return { output: buildHookOutput({ additionalContext }) };
  }

  if (agent === "claude_code") {
    const additionalContext = active && skillState.installed > 0 ? PRIM_SKILL_REMINDER : undefined;
    const reloadSkills = skillState.refreshed > 0;
    if (active) {
      const identity = getOrCreateWorkspaceId(cwd);
      if (identity.status === "ready") {
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
