/**
 * `prim welcome` — the canonical post-setup orientation message.
 *
 * Printed once the agent-driven setup (auth, session integration, daemon,
 * git hooks, skill) completes: setup.md's final step runs it and surfaces
 * the output to the user. A brief, consistent "here's how Primitive works"
 * — owned and versioned here rather than improvised per setup.
 *
 * AX contract: the human orientation block goes to STDERR (the `[prim]`
 * human-readable convention); STDOUT carries a minimal `{ welcomed: true }`
 * so the contract stays uniform and the agent gets a parse signal. Always
 * exits 0.
 */

import type { Command } from "commander";
import { bold, color, dim } from "../lib/ansi.js";
import { printJson } from "../output.js";

// Visible width of the command gutter in "Get started"; pad BEFORE dimming
// so the ANSI escapes don't throw off the description column.
const CMD_GUTTER = 38;

export function formatWelcome(): string {
  const cmd = (command: string, desc: string): string =>
    `  ${dim(command.padEnd(CMD_GUTTER))}${desc}`;
  const bullet = (text: string): string => `  ${color("•", "green")} ${text}`;

  return [
    bold(color("Welcome to Primitive", "green")),
    "",
    "Primitive captures the decisions your team makes while coding into a",
    "shared graph — and flags edits that conflict with earlier ones before",
    "they land.",
    "",
    bold("How it works"),
    bullet("Capture is automatic — keep coding; your decisions are recorded for you."),
    bullet("The conflict gate has your back: when an edit conflicts with a"),
    "    load-bearing decision, prim surfaces it. Run `prim reconcile dec_<id>` to clear",
    "    that decision and retry.",
    bullet('Occasional yes/no prompts confirm the "why" behind a decision —'),
    "    answering keeps the graph trustworthy.",
    "",
    bold("Get started"),
    cmd("prim decisions recent", "what your team has decided lately"),
    cmd("prim decisions check --files <files>", "what governs files you're about to change"),
    cmd("prim --help", "everything else"),
    "",
    dim("App: https://app.getprimitive.ai"),
  ].join("\n");
}

export function registerWelcomeCommand(program: Command): void {
  program
    .command("welcome")
    .description("Print a brief orientation to Primitive's decision graph")
    .action(() => {
      process.stderr.write(`${formatWelcome()}\n`);
      printJson({ welcomed: true });
    });
}
