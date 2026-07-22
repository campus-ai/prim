/**
 * `prim welcome` — the canonical post-setup orientation message.
 *
 * Printed once the agent-driven setup (auth, session integration, daemon,
 * git hooks, skill) completes: setup.md's final step runs it and surfaces
 * the output to the user. A brief, consistent "here's how Primitive works"
 * — owned and versioned here rather than improvised per setup.
 *
 * State-aware via one best-effort `fetchRecent` call. The seed signal is
 * VIEWER-scoped, not org-scoped: a member who has authored nothing yet is
 * seeded even in an org that already has decisions.
 *   - seed    → the requesting viewer has no decisions: the block explains
 *               that their agent will propose any decisions it finds in
 *               memory — one at a time, each confirmed by the user —
 *               and closes on the standing capture guidance. The proposal
 *               procedure itself lives in the prim skill (SKILL.md); the JSON
 *               carries the guidance verbatim (`seedGuidance`) for the agent
 *               to surface after its final proposal. If the team has
 *               decisions, they are inlined above for context.
 *   - active  → the viewer has decisions: inline the latest few team
 *               decisions (reused renderer), no seeding block.
 *   - unknown → the static get-started copy (feed unverifiable: offline,
 *               auth-expired, or org-unbound — never mistaken for seed).
 *
 * AX contract: the human orientation block goes to STDERR (the `[prim]`
 * human-readable convention); STDOUT carries the `org` discriminant + payload
 * so the agent can branch — `seed` carries `seedGuidance` and `recent`,
 * `active` carries `recent`, `unknown` carries neither. The fetch is
 * best-effort and **always exits 0** — a failure degrades to the `unknown`
 * branch, never an error, preserving setup's "welcome always lands" guarantee.
 *
 * Capture-guidance copy (the orientation bullet, the seed block's passive
 * bullet, and `seedGuidance`) is tailored per agent via `--agent`: Claude
 * Code's hooks are live at install, Codex/Hermes hooks stay inert until
 * trusted/approved, and an unknown agent gets the hedged generic form.
 * Setup passes the flag through; Hermes is auto-detected.
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

export type WelcomeAgent = "claude" | "codex" | "hermes";

const WELCOME_AGENTS: readonly string[] = ["claude", "codex", "hermes"];

/**
 * Resolve the agent whose capture guidance the welcome speaks to. An explicit
 * valid --agent wins; Hermes is auto-detected from its per-session runtime
 * marker (the same signal setup keys on); anything else — including a typo'd
 * flag — degrades to undefined (the hedged generic copy) rather than a usage
 * error, preserving welcome's always-exits-0 contract.
 */
export function resolveWelcomeAgent(
  agentFlag: string | undefined,
  env: NodeJS.ProcessEnv,
): WelcomeAgent | undefined {
  if (agentFlag !== undefined && WELCOME_AGENTS.includes(agentFlag)) {
    return agentFlag as WelcomeAgent;
  }
  if (agentFlag === undefined && env.HERMES_INTERACTIVE) {
    return "hermes";
  }
  return undefined;
}

// The capture claim is the one orientation line that varies by agent: Claude
// Code's hooks hot-reload at install, so capture truly is automatic the moment
// setup succeeds; Codex and Hermes hooks stay inert until the user trusts /
// approves them, so their copy names the unlocking action instead of
// overclaiming. An unknown agent gets the hedged generic form — never the
// unconditional claim. First line renders as the bullet, the rest indent.
type AgentCopyKey = WelcomeAgent | "generic";

const CAPTURE_LINES: Record<AgentCopyKey, string[]> = {
  claude: ["Capture is automatic — keep coding; your decisions are recorded for you."],
  codex: [
    "Capture starts once you trust the prim hooks — run /hooks in Codex;",
    "until then nothing is recorded.",
  ],
  hermes: [
    "Capture starts once you approve the prim hooks when Hermes prompts;",
    "until then nothing is recorded.",
  ],
  generic: [
    "Capture is automatic once your agent's prim hooks are active — keep",
    "coding; your decisions are recorded for you.",
  ],
};

// The seed block's passive-capture bullet, same per-agent truth in one line.
const PASSIVE_LINES: Record<AgentCopyKey, string[]> = {
  claude: ["Otherwise Primitive captures decisions passively while you work."],
  codex: [
    "Once you trust the prim hooks (/hooks in Codex), Primitive captures",
    "decisions passively while you work.",
  ],
  hermes: [
    "Once you approve the prim hooks, Primitive captures decisions",
    "passively while you work.",
  ],
  generic: [
    "Once your agent's prim hooks are active, Primitive captures decisions",
    "passively while you work.",
  ],
};

// The middle sentence of the standing seeding guidance, per agent.
const GUIDANCE_PASSIVE: Record<AgentCopyKey, string> = {
  claude: "Otherwise, Primitive passively captures decisions in the background while you work.",
  codex:
    "Otherwise, once you trust the prim hooks (run /hooks in Codex), Primitive passively captures decisions in the background while you work.",
  hermes:
    "Otherwise, once you approve the prim hooks when Hermes prompts, Primitive passively captures decisions in the background while you work.",
  generic:
    "Otherwise, once your agent's prim hooks are active, Primitive passively captures decisions in the background while you work.",
};

/**
 * The standing guidance a seeded viewer must hear once the agent-driven
 * proposal pass ends — owned and versioned here like the orientation copy.
 * The agent surfaces it verbatim after its final memory proposal (the
 * proposal procedure itself lives in the prim skill); the STDERR block
 * carries the same substance for a human running `prim welcome` directly.
 */
export function seedGuidanceFor(agent?: WelcomeAgent): string {
  return [
    "You can tell your agent to add any decision to your Primitive decision graph at any time.",
    GUIDANCE_PASSIVE[agent ?? "generic"],
    "To capture decisions in other repositories, enable Primitive there too: run `prim enable` in each one.",
  ].join(" ");
}

export type WelcomeState =
  | { org: "active"; recent: DecisionFeedRow[] }
  | { org: "seed"; recent: DecisionFeedRow[] }
  | { org: "unknown" };

/**
 * Classify the recent-feed result into a welcome branch. UNKNOWN (unverifiable
 * feed) is kept distinct, so a network blip or expired token never
 * false-triggers the reverse-prompt.
 *
 * `seed` vs `active` is VIEWER-scoped: we seed whenever the requesting user has
 * authored no decisions, even in an org that already has some (the team's
 * decisions still ride along for context). When the server doesn't report
 * `viewerHasDecisions` (a pre-flag backend), fall back to the org-scoped
 * signal — a populated feed implies the viewer is not the org's first member,
 * so don't re-seed them — preserving the prior behavior on version skew.
 */
export function welcomeStateFromRecent(result: DecisionsRecentResult): WelcomeState {
  if (result.unavailable !== undefined) {
    return { org: "unknown" };
  }
  const recent = result.decisions.slice(0, RECENT_LIMIT);
  const viewerHasDecisions = result.viewerHasDecisions ?? result.decisions.length > 0;
  if (!viewerHasDecisions) {
    return { org: "seed", recent };
  }
  return { org: "active", recent };
}

export function formatWelcome(state: WelcomeState, agent?: WelcomeAgent): string {
  const cmd = (command: string, desc: string): string =>
    `  ${dim(command.padEnd(CMD_GUTTER))}${desc}`;
  const bullet = (text: string): string => `  ${color("•", "green")} ${text}`;
  // Render a per-agent copy variant: first line bulleted, the rest indented
  // to the bullet's text column like the other wrapped bullets.
  const asBullet = ([first, ...rest]: string[]): string[] => [
    bullet(first),
    ...rest.map((line) => `    ${line}`),
  ];
  const copyKey: AgentCopyKey = agent ?? "generic";

  const head = [
    bold(color("Welcome to Primitive", "green")),
    "",
    "Primitive captures the decisions your team makes while coding into a",
    "shared graph — automatically, as you work.",
    "",
    bold("How it works"),
    ...asBullet(CAPTURE_LINES[copyKey]),
    bullet("Conflict Gates (with Enforcement) flag or block edits that conflict"),
    "    with a load-bearing decision — not currently enabled. Contact",
    "    support@getprimitive.ai to turn them on for your team.",
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
  } else if (state.org === "seed") {
    // The viewer has no decisions yet. If the team does, inline them above for
    // context; then explain the agent-driven proposal pass and close on the
    // standing guidance (the same substance SEED_GUIDANCE carries for the
    // agent/JSON consumer).
    const teamContext =
      state.recent.length > 0
        ? [bold("Recent team decisions"), ...state.recent.map(formatRecentRow), ""]
        : [];
    body = [
      ...teamContext,
      bold("Let's seed your decision graph"),
      "You haven't recorded a decision yet. Your agent will look through",
      "what you've told it and this repo's shared memory files, and propose",
      "any decisions it finds — approve, revise, or reject each one, and",
      'share the "why" when it asks. Approved decisions become part of',
      "your team's shared graph, visible to any teammates.",
      "",
      bold("From here on"),
      bullet("Tell your agent to add any decision to Primitive, any time."),
      ...asBullet(PASSIVE_LINES[copyKey]),
      bullet("Run `prim enable` in each additional repo you want captured."),
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
export function welcomeJson(state: WelcomeState, agent?: WelcomeAgent): Record<string, unknown> {
  if (state.org === "active") {
    return { welcomed: true, org: "active", recent: state.recent };
  }
  if (state.org === "seed") {
    // Carry the seeding signals: the standing guidance the agent surfaces
    // after its final memory proposal (the proposal procedure lives in the
    // prim skill), tailored to the rendering agent's capture reality, and any
    // team decisions (empty when the org itself has none) so the agent has
    // the same context shown on STDERR.
    return {
      welcomed: true,
      org: "seed",
      seedGuidance: seedGuidanceFor(agent),
      recent: state.recent,
    };
  }
  return { welcomed: true, org: "unknown" };
}

export function registerWelcomeCommand(program: Command, deps: RecentDeps = { getClient }): void {
  program
    .command("welcome")
    .description("Print a brief orientation to Primitive's decision graph")
    .option(
      "--agent <agent>",
      "claude, codex, or hermes — tailors the capture guidance (Hermes auto-detected)",
    )
    .action(async (options: { agent?: string }) => {
      const agent = resolveWelcomeAgent(options.agent, process.env);
      const result = await fetchRecent({ limit: RECENT_LIMIT }, deps);
      const state = welcomeStateFromRecent(result);
      process.stderr.write(`${formatWelcome(state, agent)}\n`);
      printJson(welcomeJson(state, agent));
    });
}
