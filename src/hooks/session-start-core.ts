import { isSessionEnded } from "../client.js";
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
import { isRepoActiveForCapture, repoActiveFlag, setRepoActive } from "../lib/activation.js";
import { gitToplevel } from "../lib/git.js";
import {
  ensureEffectivePostCommitHook,
  ensureEffectivePostRewriteHook,
} from "../lib/post-commit-hook.js";
import { bindRepository } from "../lib/repository-binding.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Agent } from "./agent.js";
import { prepareCodexContext } from "./codex-context.js";
import { type HookOutput, buildHookOutput } from "./decision-feedback-core.js";
import { normalizeEnvelope } from "./normalize.js";
import { reauthNoticeFields } from "./reauth-notice.js";

const DAEMON_TIMEOUT_MS = 250;
const REPOSITORY_BIND_TIMEOUT_MS = 1_000;

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

async function activeProjectRoot(cwd: string): Promise<string | null> {
  try {
    const root = gitToplevel(cwd);
    if (!root || !isRepoActiveForCapture(cwd)) return null;
    let shellGateActive = repoActiveFlag(root) === "true";
    if (!shellGateActive) {
      try {
        // Legacy project installs are considered active by the Node gate, but
        // the portable post-commit shell block can only read Git config.
        setRepoActive(root, true);
        shellGateActive = true;
      } catch {
        // Do not refresh to a raw-config-gated block that would silently turn
        // off commit capture. SessionStart remains fail-soft and retries later.
      }
    }
    if (shellGateActive) {
      try {
        ensureEffectivePostCommitHook(root);
      } catch {
        // SessionStart is fail-soft; doctor reports an uncovered/malformed hook.
      }
      try {
        ensureEffectivePostRewriteHook(root);
      } catch {
        // Husky may not dispatch post-rewrite; doctor reports the degradation.
      }
    }
    try {
      // Re-resolve on every session: a syntactically valid cached id can become
      // stale when the origin or the organization's connected repository
      // changes. The server remains authoritative and the write is idempotent.
      await bindRepository(root, {
        signal: AbortSignal.timeout(REPOSITORY_BIND_TIMEOUT_MS),
        quietRefresh: true,
      });
    } catch {
      // Binding is opportunistic. A later enable/SessionStart retries it.
    }
    return root;
  } catch {
    return null;
  }
}

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
  feedbackSignal?: AbortSignal,
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
  let projectRoot: string | null = null;
  let active = false;
  let skillState = { installed: 0, refreshed: 0 };
  if (agent === "claude_code") {
    projectRoot = await activeProjectRoot(cwd);
    active = projectRoot !== null;
    try {
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

  // Claude retains its existing terminal-auth notice; Codex renders the same
  // condition in its status report below so the report is the only auth line.
  if (isSessionEnded() && agent !== "codex") {
    const notice = reauthNoticeFields(agent);
    if (notice) {
      return {
        output: buildHookOutput({ ...notice, reloadSkills: skillState.refreshed > 0 }),
      };
    }
  }

  // Codex has no scriptable statusline footer. Supply the startup status report
  // here, alongside the proactive trigger when its already-loaded guidance
  // contains Prim. UserPromptSubmit owns Decision digest delivery so the first
  // real message — not SessionStart — advances the feed cursor.
  if (agent === "codex") {
    let context: Awaited<ReturnType<typeof prepareCodexContext>> | undefined;
    try {
      context = await prepareCodexContext({
        cwd,
        sessionId: envelope.session_id,
        startup: true,
        includeDigest: false,
      });
    } catch {
      // Same rule as the pre/post-tool-use call sites: a failed report loses
      // only the report — the reminder below must still reach the session.
    }

    projectRoot = await activeProjectRoot(cwd);
    active = projectRoot !== null;
    let proactive = false;
    try {
      proactive = projectRoot !== null && active && hasUsableCodexGuidance(projectRoot);
    } catch {
      // Guidance detection must never suppress otherwise-valid presence.
    }
    const additionalContext = [proactive ? CODEX_PRIM_REMINDER : undefined, context?.context]
      .filter((value): value is string => value !== undefined)
      .join("\n\n");
    return {
      output: buildHookOutput({ additionalContext }),
      acknowledge: async () => {
        await context?.acknowledge(true);
      },
    };
  }

  if (agent === "claude_code") {
    const additionalContext = active && skillState.installed > 0 ? PRIM_SKILL_REMINDER : undefined;
    const reloadSkills = skillState.refreshed > 0;
    if (active) {
      const identity = getOrCreateWorkspaceId(cwd);
      if (identity.status === "ready") {
        const signal = feedbackSignal ?? AbortSignal.timeout(FEEDBACK_DEADLINE_MS);
        const lease = await leaseDecisionFeedback({
          workspaceId: identity.workspaceId,
          currentSessionId: envelope.session_id,
          signal,
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
                  signal,
                });
              }
            : undefined,
        };
      }
    }
    return { output: buildHookOutput({ additionalContext, reloadSkills }) };
  }

  await activeProjectRoot(cwd);
  return { output: buildHookOutput({}) };
}
