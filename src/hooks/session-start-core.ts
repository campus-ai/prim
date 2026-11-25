import { getSiteUrl, isSessionEnded } from "../client.js";
import { refreshClaudePlugins } from "../commands/claude-plugin.js";
import { hasUsableCodexGuidance, hasUsableCursorSkill } from "../commands/skill.js";
import { daemonRequest } from "../daemon/client.js";
import { kickDaemonEnsure } from "../daemon/self-heal.js";
import {
  FEEDBACK_DEADLINE_MS,
  acknowledgeDecisionFeedback,
  leaseDecisionFeedback,
  renderFeedback,
} from "../decisions/feedback.js";
import {
  isRepoActiveForCapture,
  markActivationImplicit,
  repoActiveFlag,
  setRepoActive,
  withdrawImplicitActivation,
} from "../lib/activation.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { diagnoseCloudSession, isClaudeCloudSession } from "../lib/cloud-session.js";
import { fetchAndCacheCollectScope } from "../lib/collect-scope.js";
import { clearHooksWired, recordHooksWired } from "../lib/commit-heartbeat.js";
import { MANAGED_GIT_HOOK_NAMES, ensureEffectiveGitHook } from "../lib/git-hooks.js";
import { gitToplevel } from "../lib/git.js";
import { type RepositoryBindingResult, bindRepository } from "../lib/repository-binding.js";
import {
  type SessionIdentityOutcome,
  ensureSessionIdentity,
  sessionIdentityMessage,
  sessionIdentityMode,
} from "../lib/session-identity.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Agent } from "./agent.js";
import { prepareCodexContext } from "./codex-context.js";
import { type HookOutput, buildHookOutput } from "./decision-feedback-core.js";
import { normalizeEnvelope } from "./normalize.js";
import { reauthNoticeFields } from "./reauth-notice.js";

const DAEMON_TIMEOUT_MS = 250;
const REPOSITORY_BIND_TIMEOUT_MS = 1_000;
// A Claude Code cloud VM starts every resumed session cold: the first bind
// also spawns the token broker and runs discovery, the token exchange, and
// identity verification. One second failed that in a live VM and showed a
// false "not connected" notice although later hooks connected fine.
const CLOUD_REPOSITORY_BIND_TIMEOUT_MS = 10_000;
// Identifying a session pushes its branch (10 s at most) and waits up to 15 s
// for GitHub's notice to reach Primitive; the hook itself may run for 60 s.
const SESSION_IDENTITY_TIMEOUT_MS = 35_000;

/** What session start says when it could not tell who started the session. */
export function sessionIdentityNotice(
  outcome: SessionIdentityOutcome | undefined,
): { notice: string; instruction: string } | undefined {
  if (!outcome || outcome.status === "ok") return undefined;
  const notice = `${sessionIdentityMessage(outcome)} Until then, nothing this session captures is sent to Primitive.`;
  return outcome.status === "link_required"
    ? {
        notice,
        instruction: `${notice} Before starting their task, tell the user this in one sentence. When they agree, run \`prim auth link\` as a background command (it waits until they finish signing in), and give them the sign-in URL and code it prints as soon as they appear.`,
      }
    : {
        notice,
        instruction: `${notice} Tell the user this in one sentence before starting their task.`,
      };
}

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

type ActiveProject = { root: string; binding?: RepositoryBindingResult; bindFailure?: unknown };

async function activeProjectRoot(cwd: string): Promise<ActiveProject | null> {
  try {
    const root = gitToplevel(cwd);
    if (!root) return null;
    if (!isRepoActiveForCapture(cwd)) {
      // However prim was turned off here (`prim disable`, or a raw `git config
      // prim.active false`), commits from now on are not expected to reach
      // prim: drop the expectation so a later raw re-enable never has doctor
      // judge commits made meanwhile. The next active session starts a new one.
      // Only an explicit false counts: a git error or timeout reads as unset,
      // and must never erase evidence of a real failure.
      if (repoActiveFlag(root) === "false") clearHooksWired(root);
      return null;
    }
    let shellGateActive = repoActiveFlag(root) === "true";
    if (!shellGateActive) {
      try {
        // Legacy project installs are considered active by the Node gate, but
        // the portable post-commit shell block can only read Git config.
        setRepoActive(root, true);
        // Prim's write, not the user's `prim enable`: a later committed
        // opt-out must be able to withdraw it.
        markActivationImplicit(root);
        shellGateActive = true;
      } catch {
        // Do not refresh to a raw-config-gated block that would silently turn
        // off commit capture. SessionStart remains fail-soft and retries later.
      }
    }
    if (shellGateActive) {
      // Ambient repair: it writes only Git-private hook files and prim's own
      // dir, never a worktree file (a tracked .husky/*) or a shared hooks dir;
      // doctor reports what it leaves behind.
      for (const hookName of MANAGED_GIT_HOOK_NAMES) {
        try {
          // Capture hooks are wired here, as before; the pre-commit check
          // (a synchronous network call) only ever gets wired explicitly, so
          // here it is refreshed where prim already put it, never added.
          const result = ensureEffectiveGitHook(hookName, root, {
            context: "ambient",
            repairOnly: hookName === "pre-commit",
          });
          // A checkout wired before doctor's evidence check existed (or a new
          // linked worktree) has no expectation yet: start one here, once.
          if (
            hookName === "post-commit" &&
            // Manual mode: the user's own wiring is expected to reach prim too.
            ["created", "updated", "unchanged", "manual"].includes(result.outcome)
          ) {
            recordHooksWired(root, { onlyIfAbsent: true });
          }
        } catch {
          // SessionStart is fail-soft; doctor reports an uncovered/malformed hook.
        }
      }
    }
    try {
      // Re-resolve on every session: a syntactically valid cached id can become
      // stale when the origin or the organization's connected repository
      // changes. The server remains authoritative and the write is idempotent.
      const binding = await bindRepository(root, {
        signal: AbortSignal.timeout(
          isClaudeCloudSession() ? CLOUD_REPOSITORY_BIND_TIMEOUT_MS : REPOSITORY_BIND_TIMEOUT_MS,
        ),
        quietRefresh: true,
      });
      try {
        await fetchAndCacheCollectScope(root);
      } catch {
        // Collection scope is refreshed opportunistically and never delays a session.
      }
      return { root, binding };
    } catch (error) {
      // Binding is opportunistic. A later enable/SessionStart retries it; a
      // cloud session's diagnosis reads why it failed.
      return { root, bindFailure: error };
    }
  } catch {
    return null;
  }
}

function claudeBindingReminder(binding: RepositoryBindingResult, cloud = false): string {
  // A cloud VM has no browser to drive the GitHub App flow; the connection is
  // made once from the developer's own machine and then applies here too.
  if (cloud && binding.status !== "connected")
    return `GitHub repo connection is required before Primitive can attribute work in ${binding.repositoryFullName}, and it cannot be completed from this Claude Code cloud session. Before doing task work, tell the user exactly: "Primitive needs a one-time GitHub connection for ${binding.repositoryFullName}. Run \`prim github connect\` in a clone of it on your own machine, then start a new cloud session." Then continue the user's request.`;
  if (binding.status === "connected") {
    return `The GitHub repo connection is complete for ${binding.repositoryFullName}. It enables repository-specific file attribution, Conflict Gate verification, and commit correlation. In your first response, begin with exactly: "GitHub repo connection is complete for ${binding.repositoryFullName}. It enables repository-specific file attribution, Conflict Gate verification, and commit correlation." Then continue the user's request.`;
  }
  return `GitHub repo connection is required before using Primitive in this repository. It connects ${binding.repositoryFullName} to Primitive and enables repository-specific file attribution, Conflict Gate verification, and commit correlation. Before doing task work, tell the user exactly: "GitHub repo connection is required before using Primitive in this repository. It connects ${binding.repositoryFullName} to Primitive and enables repository-specific file attribution, Conflict Gate verification, and commit correlation. Shall I start the one-time GitHub connection now?" Do not begin task work or treat a decline as an opt-out. When they approve, run \`npx --yes @primitive.ai/prim github connect\`, drive the browser-based GitHub App workflow, and report the actual outcome. If it does not complete, repeat that the GitHub repo connection is required and keep prompting until it is complete. Do not call this a binding or use owner/admin escalation warnings.`;
}

interface SessionEnvelope {
  session_id?: string;
  hook_event_name?: string;
  cwd?: string;
}

export interface SessionStartResult {
  output: HookOutput | { additional_context?: string };
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

  const cwd = envelope.cwd ?? process.cwd();
  // A repository that has since committed its opt-out takes back the
  // activation an earlier session wrote down for it.
  withdrawImplicitActivation(cwd);
  if (!gitToplevel(cwd) || !isRepoActiveForCapture(cwd)) {
    // Preserve the local disable marker without starting presence or capture.
    if (repoActiveFlag(cwd) === "false") clearHooksWired(cwd);
    return { output: agent === "cursor" ? {} : buildHookOutput({}) };
  }
  warmBinCache();

  // Repair or start the supervised daemon once per agent session. Intentionally
  // detached: hook latency and output must never depend on launchctl or network
  // health, and `daemon ensure` honors an explicit stop.
  kickDaemonEnsure();

  // Preserve the pre-refresh notification ordering from the original hook:
  // synchronous Git/filesystem work must not delay session presence.
  await daemonRequest(
    "session_start",
    { sessionId: envelope.session_id, callerEnv: getSiteUrl() },
    { timeoutMs: DAEMON_TIMEOUT_MS },
  );

  let projectRoot: string | null = null;
  let active = false;
  let skillState = { installed: 0, refreshed: 0 };
  let claudeBinding: RepositoryBindingResult | undefined;
  let bindFailure: unknown;
  let identityNotice: ReturnType<typeof sessionIdentityNotice>;
  if (agent === "claude_code") {
    // An organization-shared cloud environment: learn who started this
    // session before anything is sent, so it is sent as them.
    let identityMode = false;
    try {
      identityMode = sessionIdentityMode();
    } catch {
      // A misconfigured environment is diagnosed below like any other.
    }
    if (identityMode) {
      try {
        identityNotice = sessionIdentityNotice(
          await ensureSessionIdentity({
            cwd,
            explicit: true,
            signal: AbortSignal.timeout(SESSION_IDENTITY_TIMEOUT_MS),
          }),
        );
      } catch {
        // SessionStart is fail-soft; `prim setup --cloud` reports the identity step.
      }
    }
    const activeProject = await activeProjectRoot(cwd);
    projectRoot = activeProject?.root ?? null;
    active = projectRoot !== null;
    // Like every other hook, the binding reminder speaks only where prim is
    // active: `activeProjectRoot` returns null for an unenabled repo, so an
    // opted-out checkout gets no reminder and no bind request.
    claudeBinding = activeProject?.binding;
    bindFailure = activeProject?.bindFailure;
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
  if (isSessionEnded() && agent !== "codex" && agent !== "cursor") {
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

    projectRoot = (await activeProjectRoot(cwd))?.root ?? null;
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

  if (agent === "cursor") {
    const activeProject = await activeProjectRoot(cwd);
    projectRoot = activeProject?.root ?? null;
    active = projectRoot !== null;
    let context: Awaited<ReturnType<typeof prepareCodexContext>> | undefined;
    try {
      context = await prepareCodexContext({
        cwd,
        sessionId: envelope.session_id,
        startup: true,
        includeDigest: true,
        namespace: "cursor",
      });
    } catch {
      // Presence and the installed-workflow reminder remain independently useful.
    }
    let proactive = false;
    try {
      proactive = projectRoot !== null && active && hasUsableCursorSkill(projectRoot);
    } catch {
      // Skill detection is advisory and must not suppress status context.
    }
    const additionalContext = [proactive ? CODEX_PRIM_REMINDER : undefined, context?.context]
      .filter((value): value is string => value !== undefined)
      .join("\n\n");
    return {
      output: additionalContext ? { additional_context: additionalContext } : {},
      acknowledge: async () => {
        await context?.acknowledge(true);
      },
    };
  }

  if (agent === "claude_code") {
    // In a Claude Code cloud session an unbound active repository usually means
    // missing or rejected credentials or a blocked host, all of which otherwise
    // fail open without a word. Name the fix where the user and agent will see it.
    let cloudNotice: string | undefined = identityNotice?.notice;
    if (active && !claudeBinding && isClaudeCloudSession() && !identityNotice) {
      try {
        cloudNotice = await diagnoseCloudSession({ cwd: projectRoot ?? cwd, bindFailure });
      } catch {
        // The diagnosis is advisory; SessionStart stays fail-soft.
      }
    }
    const additionalContext = [
      identityNotice
        ? identityNotice.instruction
        : cloudNotice
          ? `${cloudNotice} Tell the user this in one sentence before starting their task.`
          : undefined,
      claudeBinding ? claudeBindingReminder(claudeBinding, isClaudeCloudSession()) : undefined,
      active && skillState.installed > 0 ? PRIM_SKILL_REMINDER : undefined,
    ]
      .filter((value): value is string => value !== undefined)
      .join("\n\n");
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
            systemMessage:
              [cloudNotice, rendered?.systemMessage].filter(Boolean).join("\n\n") || undefined,
            additionalContext,
            reloadSkills,
          }),
          acknowledge: rendered
            ? async () => {
                await acknowledgeDecisionFeedback({
                  protocolVersion: rendered.protocolVersion,
                  workspaceId: identity.workspaceId,
                  deliveries: rendered.deliveries,
                  signal,
                });
              }
            : undefined,
        };
      }
    }
    return {
      output: buildHookOutput({ systemMessage: cloudNotice, additionalContext, reloadSkills }),
    };
  }

  await activeProjectRoot(cwd);
  return { output: buildHookOutput({}) };
}
