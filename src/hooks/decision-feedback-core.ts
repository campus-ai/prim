export type HookOutput = {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: "SessionStart";
    additionalContext?: string;
    reloadSkills?: boolean;
  };
};

export function buildHookOutput(options: {
  systemMessage?: string;
  additionalContext?: string;
  reloadSkills?: boolean;
}): HookOutput {
  const output: HookOutput = {};
  if (options.systemMessage) output.systemMessage = options.systemMessage;
  // Assemble the payload first so each future field is one line here; the
  // envelope (with its event name) is attached only when a payload exists.
  const fields: Omit<NonNullable<HookOutput["hookSpecificOutput"]>, "hookEventName"> = {};
  if (options.additionalContext) fields.additionalContext = options.additionalContext;
  if (options.reloadSkills) fields.reloadSkills = true;
  if (Object.keys(fields).length > 0) {
    output.hookSpecificOutput = { hookEventName: "SessionStart", ...fields };
  }
  return output;
}

type WritableOutput = {
  once(event: "error", listener: (error: Error) => void): unknown;
  off(event: "error", listener: (error: Error) => void): unknown;
  write(chunk: string, callback: (error?: Error | null) => void): boolean;
};

/** Resolve only after the hook protocol payload has reached the stdout stream. */
export function writeHookOutput(
  output: HookOutput,
  stream: WritableOutput = process.stdout,
): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const finish = (ok: boolean, retainErrorListener = false): void => {
      if (settled) return;
      settled = true;
      if (!retainErrorListener) stream.off("error", onError);
      resolve(ok);
    };
    const onError = (): void => {
      if (settled) {
        stream.off("error", onError);
        return;
      }
      finish(false);
    };
    stream.once("error", onError);
    try {
      stream.write(`${JSON.stringify(output)}\n`, (error) =>
        error ? finish(false, true) : finish(true),
      );
    } catch {
      finish(false);
    }
  });
}

/** Keep deletion causally after stdout; acknowledgment failure stays fail-soft. */
export async function handoffHookOutput(
  output: HookOutput,
  acknowledge?: () => Promise<unknown>,
  stream: WritableOutput = process.stdout,
): Promise<boolean> {
  const handedOff = await writeHookOutput(output, stream);
  if (handedOff && acknowledge) {
    try {
      await acknowledge();
    } catch {
      // An unacknowledged lease is intentionally redelivered after expiry.
    }
  }
  return handedOff;
}
