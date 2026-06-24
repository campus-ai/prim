/**
 * `prim welcome` — the canonical post-setup orientation message.
 *
 * Printed once the agent-driven setup (auth, session integration, daemon,
 * git hooks, skill) completes: setup.md's final step runs it and surfaces
 * the output to the user. A brief, consistent "here's how Primitive works"
 * — owned and versioned here rather than improvised per setup.
 *
 * Now org-state aware via one best-effort `fetchRecent` call:
 *   - active org → inline the latest few team decisions (reused renderer),
 *   - empty org  → a reverse-prompt asking what the user is focusing on (and
 *     not), which the setup agent collects and breaks into decisions,
 *   - unknown    → the static get-started copy (feed unverifiable: offline,
 *     auth-expired, or org-unbound — never mistaken for a healthy empty org).
 *
 * AX contract: the human orientation block goes to STDERR (the `[prim]`
 * human-readable convention); STDOUT carries the org state + payload
 * (`{ welcomed, org, recent | reversePrompt }`) so the agent can branch.
 * The fetch is best-effort and **always exits 0** — a failure degrades to
 * the `unknown` branch, never an error, preserving setup's "welcome always
 * lands" guarantee.
 */

import type { Command } from "commander";
import { getClient } from "../client.js";
import {
  type DecisionFeedRow,
  type DecisionsRecentResult,
  type RecentDeps,
  fetchRecent,
  formatRecentRow,
} from "../decisions/recent.js";
import { bold, color, dim } from "../lib/ansi.js";
import { printJson } from "../output.js";

// Visible width of the command gutter in "Get started"; pad BEFORE dimming
// so the ANSI escapes don't throw off the description column.
const CMD_GUTTER = 38;

// How many recent decisions to inline for an active org (the "3-5" target).
const RECENT_LIMIT = 5;

// The reverse-prompt for an org with no decisions yet — owned and versioned
// here like the orientation copy. Stored as display lines (wrapped for the
// terminal); REVERSE_PROMPT is the flat form the agent/JSON consumer reads.
const REVERSE_PROMPT_LINES = [
  "What are the most important goals in your organization that you're",
  "responsible for, right now? What are you not focusing on, in order",
  "to focus on those goals?",
];
export const REVERSE_PROMPT = REVERSE_PROMPT_LINES.join(" ");

export type WelcomeState =
  | { org: "active"; recent: DecisionFeedRow[] }
  | { org: "empty" }
  | { org: "unknown" };

/**
 * Classify the recent-feed result into a welcome branch. UNKNOWN (unverifiable
 * feed) is kept distinct from a healthy empty org, so a network blip or expired
 * token never false-triggers the reverse-prompt.
 */
export function welcomeStateFromRecent(result: DecisionsRecentResult): WelcomeState {
  if (result.unavailable !== undefined) {
    return { org: "unknown" };
  }
  if (result.decisions.length === 0) {
    return { org: "empty" };
  }
  return { org: "active", recent: result.decisions.slice(0, RECENT_LIMIT) };
}

export function formatWelcome(state: WelcomeState): string {
  const cmd = (command: string, desc: string): string =>
    `  ${dim(command.padEnd(CMD_GUTTER))}${desc}`;
  const bullet = (text: string): string => `  ${color("•", "green")} ${text}`;

  const head = [
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
  ];

  let body: string[];
  if (state.org === "active") {
    body = [
      bold("Recent team decisions"),
      ...state.recent.map(formatRecentRow),
      "",
      bold("Get started"),
      cmd("prim decisions check --files <files>", "what governs files you're about to change"),
      cmd("prim --help", "everything else"),
    ];
  } else if (state.org === "empty") {
    body = [
      bold("Let's seed your decision graph"),
      "Your team has no decisions recorded yet. Tell me, in your own words:",
      "",
      ...REVERSE_PROMPT_LINES.map((line) => `  ${line}`),
      "",
      "Share your answer and I'll record each goal as a decision.",
    ];
  } else {
    body = [
      bold("Get started"),
      cmd("prim decisions recent", "what your team has decided lately"),
      cmd("prim decisions check --files <files>", "what governs files you're about to change"),
      cmd("prim --help", "everything else"),
    ];
  }

  return [...head, ...body, "", dim("App: https://app.getprimitive.ai")].join("\n");
}

/** STDOUT payload: the org state plus the branch-specific signal for the agent. */
export function welcomeJson(state: WelcomeState): Record<string, unknown> {
  if (state.org === "active") {
    return { welcomed: true, org: "active", recent: state.recent };
  }
  if (state.org === "empty") {
    return { welcomed: true, org: "empty", reversePrompt: REVERSE_PROMPT };
  }
  return { welcomed: true, org: "unknown" };
}

export function registerWelcomeCommand(program: Command, deps: RecentDeps = { getClient }): void {
  program
    .command("welcome")
    .description("Print a brief orientation to Primitive's decision graph")
    .action(async () => {
      const result = await fetchRecent({ limit: RECENT_LIMIT }, deps);
      const state = welcomeStateFromRecent(result);
      process.stderr.write(`${formatWelcome(state)}\n`);
      printJson(welcomeJson(state));
    });
}
