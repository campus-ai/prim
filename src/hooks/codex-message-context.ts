import { prepareCodexContext } from "./codex-context.js";

export type CodexMessageContextOutput =
  | Record<string, never>
  | {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit";
        additionalContext: string;
      };
    };

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

/** Build the Codex protocol response for prompt-time Decision delivery. */
export async function processCodexMessageContext(
  envelope: CodexMessageContextEnvelope,
  deps: CodexMessageContextDeps = defaultDeps,
): Promise<CodexMessageContextResult> {
  const event = envelope.hook_event_name;
  // A blocking Stop response becomes a synthetic continuation prompt in Codex,
  // displacing the assistant's completed handoff in current clients. Keep the
  // digest pending and deliver it as additional context on the next real user
  // prompt instead. Stop capture itself is handled independently by prim-hook.
  if (event === "Stop") return { output: {} };
  if (event !== "UserPromptSubmit") return { output: {} };
  if (typeof envelope.session_id !== "string" || envelope.session_id.length === 0) {
    return { output: {} };
  }

  let prepared: Awaited<ReturnType<typeof prepareCodexContext>>;
  try {
    prepared = await deps.prepare({
      cwd: typeof envelope.cwd === "string" ? envelope.cwd : process.cwd(),
      sessionId: envelope.session_id,
    });
  } catch {
    return { output: {} };
  }

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
