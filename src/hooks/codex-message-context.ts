import { prepareCodexContext } from "./codex-context.js";

type CodexContextEvent = "UserPromptSubmit" | "Stop";

export type CodexMessageContextOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit";
        additionalContext: string;
      };
    }
  | { decision: "block"; reason: string };

export interface CodexMessageContextResult {
  output: CodexMessageContextOutput;
  acknowledge?: () => Promise<void>;
}

export interface CodexMessageContextEnvelope {
  hook_event_name?: unknown;
  session_id?: unknown;
  cwd?: unknown;
  stop_hook_active?: unknown;
}

export interface CodexMessageContextDeps {
  prepare: typeof prepareCodexContext;
}

const defaultDeps: CodexMessageContextDeps = { prepare: prepareCodexContext };

const STOP_BACKSTOP_INSTRUCTION =
  "A new Primitive Decision arrived during this turn. Incorporate it into the active task and proactively tell the user about it before finishing.";

/** Build the Codex protocol response for the two Decision-delivery events. */
export async function processCodexMessageContext(
  envelope: CodexMessageContextEnvelope,
  deps: CodexMessageContextDeps = defaultDeps,
): Promise<CodexMessageContextResult> {
  const event = envelope.hook_event_name;
  if (event !== "UserPromptSubmit" && event !== "Stop") return { output: {} };
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    return { output: {} };
  }
  // Codex re-runs Stop after a blocking Stop hook. Never recurse: the first
  // response already handed off and acknowledged the Decision digest.
  if (event === "Stop" && envelope.stop_hook_active === true) return { output: {} };

  let prepared: Awaited<ReturnType<typeof prepareCodexContext>>;
  try {
    prepared = await deps.prepare({
      cwd: typeof envelope.cwd === "string" ? envelope.cwd : process.cwd(),
      sessionId: envelope.session_id,
    });
  } catch {
    return { output: {} };
  }

  if (event === "UserPromptSubmit") {
    return {
      output: prepared.context
        ? {
            hookSpecificOutput: {
              hookEventName: "UserPromptSubmit",
              additionalContext: prepared.context,
            },
          }
        : {},
      // Even an empty prompt response is a successful handoff. Committing it
      // advances verified feed state and report dedup without inventing output.
      acknowledge: async () => {
        await prepared.acknowledge(true);
      },
    };
  }

  if (!prepared.decisionDigest) {
    // A status-only change was not delivered at Stop; leave it unacknowledged
    // so the next UserPromptSubmit receives it as developer context.
    return { output: {} };
  }
  return {
    output: {
      decision: "block",
      reason: `${prepared.context ?? prepared.decisionDigest}\n\n${STOP_BACKSTOP_INSTRUCTION}`,
    },
    acknowledge: async () => {
      await prepared.acknowledge(true);
    },
  };
}
