import type { OptionValues } from "commander";

/**
 * Whether prim should fail fast instead of prompting. True when the global
 * `--non-interactive` flag is set, or the environment marks a non-interactive
 * context (`CI`, `PRIM_NON_INTERACTIVE`). Callers pass `command.optsWithGlobals()`.
 * Keeps the "when do we prompt" contract (mirrored in `--non-interactive`'s help
 * text) in one place so every prompting command agrees.
 */
export function isNonInteractive(globals: OptionValues): boolean {
  return Boolean(globals.nonInteractive || process.env.CI || process.env.PRIM_NON_INTERACTIVE);
}

/** Ask a conservative yes/no question on an interactive terminal. */
export async function askConfirmation(
  question: string,
  output: NodeJS.WritableStream = process.stdout,
): Promise<boolean> {
  if (!process.stdin.isTTY) return false;

  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    const normalized = answer.trim().toLowerCase();
    return normalized === "y" || normalized === "yes";
  } finally {
    rl.close();
  }
}
