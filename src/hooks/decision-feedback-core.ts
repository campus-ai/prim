import {
  drainDecisionFeedback,
  formatDecisionFeedbackSystemMessage,
} from "../decisions/feedback.js";
import { isRepoActiveForCapture } from "../lib/activation.js";
import { gitToplevel } from "../lib/git.js";

const FEEDBACK_EVENTS = new Set(["Stop", "SessionStart"]);

export interface DecisionFeedbackHookEnvelope {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
}

export interface DecisionFeedbackHookDeps {
  isRepoActiveForCapture: (cwd: string) => boolean;
  gitToplevel: (cwd?: string) => string | null;
  drainDecisionFeedback: typeof drainDecisionFeedback;
}

const defaultDeps: DecisionFeedbackHookDeps = {
  isRepoActiveForCapture,
  gitToplevel,
  drainDecisionFeedback,
};

export async function decisionFeedbackSystemMessage(
  envelope: DecisionFeedbackHookEnvelope,
  deps: DecisionFeedbackHookDeps = defaultDeps,
): Promise<string | undefined> {
  if (!FEEDBACK_EVENTS.has(envelope.hook_event_name ?? "")) {
    return;
  }
  const cwd =
    typeof envelope.cwd === "string" && envelope.cwd.length > 0 ? envelope.cwd : process.cwd();
  if (!deps.isRepoActiveForCapture(cwd)) {
    return;
  }
  const repoCwd = deps.gitToplevel(cwd);
  if (!repoCwd) {
    return;
  }
  const sessionId =
    typeof envelope.session_id === "string" && envelope.session_id.length > 0
      ? envelope.session_id
      : undefined;
  if (!sessionId) {
    return;
  }
  try {
    return formatDecisionFeedbackSystemMessage(
      await deps.drainDecisionFeedback({
        repoCwd,
        scope: "session",
        sessionId,
      }),
    );
  } catch {
    return;
  }
}
