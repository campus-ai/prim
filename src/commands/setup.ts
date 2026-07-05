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
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { gitToplevel } from "../lib/git.js";

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
  // Forward scope to the git hooks and the rules file too, so `--scope user`
  // (the default) installs a global core.hooksPath and the agent's global rules
  // file — the whole point of user scope is zero per-repo setup. Unlike the
  // session step, hooks/skill take `--scope user` for every agent (hermes
  // included: its global hooks + ~/.hermes/.hermes.md).
  steps.push({
    key: "hooks",
    label: "Git hooks",
    args: ["hooks", "install", ...scopeArgs],
    required: true,
  });
  // The rules file follows the agent: claude→CLAUDE.md, codex→AGENTS.md,
  // hermes→.hermes.md. Passing --agent lets `skill install` pick it
  // deterministically — vs. auto-detection, which could land a non-Claude agent
  // on CLAUDE.md (its no-candidate default).
  const skillArgs = ["skill", "install", "--agent", opts.agent, ...scopeArgs];
  steps.push({ key: "skill", label: "Agent skill", args: skillArgs, required: true });
  if (opts.scope === "user") {
    // The global git hooks are opt-in per repo (they act only where prim.active
    // is true). Activate THIS repo so its commits are captured out of the box;
    // other repos opt in later with `prim enable`. Tolerated skip: setup may run
    // outside a git repo.
    steps.push({ key: "enable", label: "Activate this repo", args: ["enable"], required: false });
  }
  return steps;
}

type RunFn = (args: string[], capture?: boolean) => { code: number; stdout: string };

/**
 * The project-scope prim artifacts to detect in the current repo before a
 * user-scope install. Order matters only for the trail message; each maps to an
 * existing uninstall subcommand via planCleanupUninstalls.
 */
const CONFLICT_SESSION = "session";
const CONFLICT_HOOKS = "hooks";
const CONFLICT_SKILL = "skill";

/**
 * Map detected project-scope conflicts to the uninstall commands that clear
 * them. Pure, so the migration mapping is unit-tested without spawning. Hermes
 * has no project scope, so its session hooks are never a conflict.
 */
export function planCleanupUninstalls(agent: SetupAgent, conflicts: string[]): string[][] {
  const steps: string[][] = [];
  if (conflicts.includes(CONFLICT_SESSION) && agent !== "hermes") {
    steps.push([agent, "uninstall", "--scope", "project"]);
  }
  if (conflicts.includes(CONFLICT_HOOKS)) steps.push(["hooks", "uninstall"]);
  if (conflicts.includes(CONFLICT_SKILL)) steps.push(["skill", "uninstall", "--agent", agent]);
  return steps;
}

/**
 * Detect project-scoped prim config lingering in the current repo — it would
 * double-fire alongside a fresh user-scope install. Reuses the existing status
 * subcommands (their JSON is on STDOUT) for the session + rules file, and a
 * direct read for the git hook (there is no `hooks status`). Every probe is
 * fail-soft: a missing/erroring signal is simply "not present".
 */
function detectProjectConflicts(agent: SetupAgent, run: RunFn): string[] {
  const conflicts: string[] = [];

  // Session hooks — hermes has no project scope, so never a conflict.
  if (agent !== "hermes") {
    try {
      const parsed = JSON.parse(run([agent, "status"], true).stdout || "{}") as {
        project?: { gate?: boolean; capture?: boolean };
      };
      if (parsed.project?.gate || parsed.project?.capture) conflicts.push(CONFLICT_SESSION);
    } catch {
      // no readable status → treat as absent
    }
  }

  // Project git hook in this repo's .git/hooks.
  try {
    const root = gitToplevel();
    const preCommit = root && join(root, ".git", "hooks", "pre-commit");
    if (
      preCommit &&
      existsSync(preCommit) &&
      readFileSync(preCommit, "utf-8").includes("prim-pre-commit")
    ) {
      conflicts.push(CONFLICT_HOOKS);
    }
  } catch {
    // not a repo / no hook → absent
  }

  // Project rules file (skill status without --scope resolves the cwd target).
  try {
    const parsed = JSON.parse(
      run(["skill", "status", "--agent", agent, "--json"], true).stdout || "{}",
    ) as { installed?: boolean };
    if (parsed.installed) conflicts.push(CONFLICT_SKILL);
  } catch {
    // no readable status → absent
  }

  return conflicts;
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
    .option(
      "--scope <scope>",
      "user (default — install once for every repo) or project (this repo only)",
      "user",
    )
    .option(
      "--migrate",
      "with the default user scope, remove any project-scoped prim config in this repo (else just warn)",
    )
    .option("--no-daemon", "skip starting the companion daemon")
    .action((opts: { agent?: string; scope: string; migrate?: boolean; daemon: boolean }) => {
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
        // Capturing a step means we only want its machine STDOUT (JSON) — a
        // status/auth probe. Silence its human STDERR so status-line noise
        // ("gate ✓ · capture ✗ …") doesn't interleave into the setup trail.
        const r = spawnSync(process.execPath, [self, ...args], {
          stdio: capture ? ["inherit", "pipe", "ignore"] : "inherit",
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

      // N+1 · Migrate — with the (default) user scope, a lingering PROJECT-scoped
      // install in this repo double-fires alongside the user-scope one. Detect it;
      // with --migrate remove it via the existing uninstall subcommands, else warn
      // with the one-flag remedy so the user opts in explicitly.
      if (scope === "user") {
        const conflicts = detectProjectConflicts(agent, run);
        if (conflicts.length > 0 && opts.migrate) {
          note(`migrate · removing project-scoped config (${conflicts.join(", ")})…`);
          // Attempt EVERY removal (map, not .every) — a short-circuit would leave
          // a half-migrated, still-double-firing repo on the first failure.
          const ok = planCleanupUninstalls(agent, conflicts)
            .map((args) => run(args).code === 0)
            .every(Boolean);
          results.migrate = ok ? "ok" : "failed";
        } else if (conflicts.length > 0) {
          note(
            `migrate · project-scoped prim config present in this repo (${conflicts.join(", ")}) — it will double-fire with the user-scope install. Re-run \`prim setup --migrate\` to remove it.`,
          );
        }
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
