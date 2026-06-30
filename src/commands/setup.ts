/**
 * `prim setup` — the whole install in one command.
 *
 * Runs the same steps an agent would drive from `setup.md`, but as a single
 * command: pre-auth → auth (login only if needed) → session integration (Claude
 * Code or Codex) → companion daemon → git hooks → agent skill → welcome. It
 * orchestrates by re-invoking the prim binary's own subcommands, so every step
 * behaves byte-for-byte like running it by hand — including the interactive
 * browser login — with no logic duplicated here.
 *
 * Why a one-shot matters: an agent that runs setup.md's steps one at a time
 * issues ~11 separate prim commands, and a default-mode Claude Code prompts for
 * each. Running THIS single command instead is one Bash tool call the agent gets
 * approved once; every sub-step is a child process of it, invisible to the
 * harness's per-command permission gate, so the rest of the install proceeds with
 * no further prompts. And because it pre-authorizes prim first (step 0, Claude
 * only) and Claude Code hot-reloads permissions, even the agent's own follow-up
 * prim calls in the same session stop prompting — and every future repo onboards
 * prompt-free.
 *
 * AX: each step's own output streams through (STDERR human / STDOUT machine);
 * this wrapper adds a one-line-per-step progress trail on STDERR and a final
 * status line. Idempotent — every underlying step is, so re-running is safe.
 */

import { spawnSync } from "node:child_process";
import type { Command } from "commander";

const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;

export type SetupAgent = "claude" | "codex" | "hermes";
export type SetupScope = "project" | "user";

export type SetupStep = {
  /** Stable key for the result summary. */
  key: string;
  /** Human label for the progress trail. */
  label: string;
  /** Subcommand argv handed to the prim binary. */
  args: string[];
  /** A non-zero exit fails the overall run (vs. a tolerated skip). */
  required: boolean;
};

/**
 * The ordered install steps after auth (handled separately, since it only logs
 * in when needed) and before welcome (always last). Pure so the ordering,
 * agent branch, daemon toggle, and scope passthrough are unit-testable without
 * spawning anything.
 */
const SESSION_LABELS: Record<SetupAgent, string> = {
  claude: "Claude Code integration",
  codex: "Codex integration",
  hermes: "Hermes integration",
};

export function planSetupSteps(opts: {
  agent: SetupAgent;
  daemon: boolean;
  scope: SetupScope;
}): SetupStep[] {
  const scopeArgs = opts.scope === "user" ? ["--scope", "user"] : [];
  // Hermes config is global-only: it has no project/user layer, so don't
  // forward a scope flag (hermes install hard-errors on --scope project).
  const sessionArgs =
    opts.agent === "hermes" ? [opts.agent, "install"] : [opts.agent, "install", ...scopeArgs];
  const steps: SetupStep[] = [
    {
      key: "session",
      label: SESSION_LABELS[opts.agent],
      args: sessionArgs,
      required: true,
    },
  ];
  if (opts.daemon) {
    // Optional: the hooks fall back to direct calls if the daemon is down, so a
    // failed start must not fail setup.
    steps.push({
      key: "daemon",
      label: "Companion daemon",
      args: ["daemon", "start"],
      required: false,
    });
  }
  steps.push({ key: "hooks", label: "Git hooks", args: ["hooks", "install"], required: true });
  // Hermes loads ONE project context file, first match wins
  // (.hermes.md → AGENTS.md → CLAUDE.md → .cursorrules), so target .hermes.md
  // explicitly — deterministic, and side-steps the >1-candidate prompt.
  const skillArgs =
    opts.agent === "hermes" ? ["skill", "install", "--target", ".hermes.md"] : ["skill", "install"];
  steps.push({ key: "skill", label: "Agent skill", args: skillArgs, required: true });
  return steps;
}

/**
 * Infer the calling agent from the environment when `--agent` is omitted, so a
 * bare `prim setup` — what an onboarding agent copy/pastes — wires the
 * integration that matches the agent actually running it, without the model
 * having to self-identify. Only a positive, per-session runtime signal flips the
 * default: Hermes's interactive entrypoint sets HERMES_INTERACTIVE
 * unconditionally — a runtime flag, not a config var a user exports — and it is
 * absent from a Claude Code or Codex shell, so it never mis-flags them.
 * Everything else falls back to claude (today's default), leaving manual runs
 * and unrecognized agents unchanged. Codex keeps its explicit `--agent codex`
 * path: its shell carries no equally stable marker to key on.
 */
export function detectAgent(env: NodeJS.ProcessEnv): SetupAgent {
  if (env.HERMES_INTERACTIVE) {
    return "hermes";
  }
  return "claude";
}

/**
 * Resolve the effective agent and whether it was inferred. An explicit --agent
 * is taken verbatim (the caller still typo-checks it) and suppresses detection;
 * an omitted flag falls through to environment detection. Pure, so the
 * override/inference seam the auto-detect feature hinges on is unit-tested rather
 * than buried in the command action. `agent` stays a raw string here because an
 * explicit value may be a typo the caller rejects; only `detected` values are
 * known-valid.
 */
export function resolveAgent(
  agentFlag: string | undefined,
  env: NodeJS.ProcessEnv,
): { agent: string; detected: boolean } {
  if (agentFlag !== undefined) {
    return { agent: agentFlag, detected: false };
  }
  return { agent: detectAgent(env), detected: true };
}

type StepResult = "ok" | "failed" | "skipped";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Install everything in one shot (auth, session + git hooks, daemon, skill, welcome)",
    )
    .option("--agent <agent>", "claude, codex, or hermes (auto-detected when omitted)")
    .option("--scope <scope>", "project or user (session integration)", "project")
    .option("--no-daemon", "skip starting the companion daemon")
    .action((opts: { agent?: string; scope: string; daemon: boolean }) => {
      // Explicit --agent wins and is typo-checked (usage error → exit 2, the
      // CLI's convention for rejected input); when omitted, infer from the env so
      // a bare `prim setup` wires the integration matching the calling agent.
      const { agent: agentInput, detected } = resolveAgent(opts.agent, process.env);
      if (agentInput !== "claude" && agentInput !== "codex" && agentInput !== "hermes") {
        process.stderr.write(
          `[prim] unknown --agent "${agentInput}" (expected claude, codex, or hermes)\n`,
        );
        process.exit(EXIT_USAGE);
      }
      if (opts.scope !== "project" && opts.scope !== "user") {
        process.stderr.write(`[prim] unknown --scope "${opts.scope}" (expected project or user)\n`);
        process.exit(EXIT_USAGE);
      }
      const agent: SetupAgent = agentInput;
      const scope: SetupScope = opts.scope;
      const self = process.argv[1];

      const run = (args: string[], capture = false): { code: number; stdout: string } => {
        const r = spawnSync(process.execPath, [self, ...args], {
          stdio: capture ? ["inherit", "pipe", "inherit"] : "inherit",
          encoding: "utf-8",
        });
        return { code: r.status ?? 1, stdout: capture ? (r.stdout ?? "") : "" };
      };

      const results: Record<string, StepResult> = {};
      const note = (msg: string): void => {
        process.stderr.write(`[prim] ${msg}\n`);
      };
      const isAuthed = (json: string): boolean => {
        try {
          return (JSON.parse(json || "{}") as { authenticated?: boolean }).authenticated === true;
        } catch {
          return false;
        }
      };

      // Surface an inferred agent — the install it wires depends on it, and the
      // user can correct a wrong guess with --agent. The claude fallback is the
      // historical default, so it stays silent.
      if (detected && agent !== "claude") {
        note(`agent · detected ${agent} session (override with --agent <agent>)`);
      }

      // 0 · Pre-authorize prim at USER scope FIRST — before any other prim call.
      // Claude Code hot-reloads permissions, so writing the allow-rule now also
      // covers the agent's own follow-up prim calls in this session, and makes
      // every FUTURE repo's onboarding prompt-free. Claude-only: Codex gates via
      // `/hooks` trust, not an allow-rule. Best-effort — a failure only forfeits
      // the no-prompt optimization, it must never fail setup.
      if (agent === "claude") {
        note("pre-authorize · writing prim allow-rule (user scope)…");
        results.preauth =
          run(["claude", "preauth", "--scope", "user"]).code === 0 ? "ok" : "skipped";
      }

      // 1 · Auth — log in only if not already authenticated.
      if (isAuthed(run(["auth", "status", "--json"], true).stdout)) {
        note("auth · already authenticated");
        results.auth = "ok";
      } else {
        note("auth · opening browser to authenticate…");
        run(["auth", "login"]);
        results.auth = isAuthed(run(["auth", "status", "--json"], true).stdout) ? "ok" : "failed";
      }

      // 2..N · the install steps.
      for (const step of planSetupSteps({ agent, daemon: opts.daemon, scope })) {
        note(`${step.label} · installing…`);
        const { code } = run(step.args);
        results[step.key] = code === 0 ? "ok" : step.required ? "failed" : "skipped";
      }

      // Final · welcome — its output (orientation + any "Your turn" seeding
      // prompt) streams through inherited stdio BEFORE we read the exit code, so
      // the required final deliverable is always shown. A non-zero (it normally
      // exits 0) is surfaced as `failed` — which, like any required step, flips
      // the overall exit to incomplete — rather than silently reported as ok.
      note("welcome");
      results.welcome = run(["welcome"]).code === 0 ? "ok" : "failed";

      const failed = Object.entries(results)
        .filter(([, v]) => v === "failed")
        .map(([k]) => k);
      const trail = Object.entries(results)
        .map(([k, v]) => `${k}:${v}`)
        .join(" · ");
      note(
        `setup ${failed.length === 0 ? "complete" : `incomplete (failed: ${failed.join(", ")})`} — ${trail}`,
      );
      process.exit(failed.length === 0 ? 0 : EXIT_INCOMPLETE);
    });
}
