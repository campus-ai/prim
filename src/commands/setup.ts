/**
 * `prim setup` — the whole install in one command.
 *
 * Runs the same steps an agent would drive from `setup.md`, but as a single
 * command: auth verification/login → pre-auth → session integration (Claude
 * Code, Codex, Cursor, or Hermes) → companion daemon → git hooks → agent skill → welcome. It
 * orchestrates by re-invoking the prim binary's own subcommands, so every step
 * behaves byte-for-byte like running it by hand — including the interactive
 * browser login — with no logic duplicated here.
 *
 * Why a one-shot matters: an agent that runs setup.md's steps one at a time
 * issues ~11 separate prim commands, and a default-mode Claude Code prompts for
 * each. Running THIS single command instead is one Bash tool call the agent gets
 * approved once; every sub-step is a child process of it, invisible to the
 * harness's per-command permission gate, so the rest of the install proceeds with
 * no further prompts. Once auth is verified it pre-authorizes prim (Claude
 * only), and because Claude Code hot-reloads permissions, the agent's follow-up
 * prim calls in the same session stop prompting — and every future repo onboards
 * prompt-free.
 *
 * AX: each step's own output streams through (STDERR human / STDOUT machine);
 * this wrapper adds a one-line-per-step progress trail on STDERR and a final
 * status line. Idempotent — every underlying step is, so re-running is safe.
 */

import { type SpawnSyncOptionsWithStringEncoding, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { gitHooksMode, resolveEffectiveGitHook } from "../lib/git-hooks.js";
import { gitToplevel } from "../lib/git.js";
import {
  EXIT_GLOBAL_HOOKS_NOT_INSTALLED,
  type GlobalHooksPlan,
  globalHooksPathIsPrims,
  planGlobalHooks,
} from "./hooks.js";

const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;
// Marks every one of setup's child steps. Setup starts or stops the daemon
// itself, so none of its steps starts an implicit daemon upgrade. That is all
// it guarantees. A separate attended command run while setup is in progress
// can still start a heal, such as the `auth status --json` poll setup.md
// suggests during a background setup. Such a heal is harmless: its ensure
// serializes with setup's daemon step on the lifecycle lock, honors a stop,
// and targets the same version when both run from the same package.
export const SETUP_ORCHESTRATOR_ENV = "PRIM_SETUP_ORCHESTRATOR";
// Marks setup's child steps only when setup starts the daemon. Setup then
// checks the daemon's delivery health, so its children leave the journal
// drain to the daemon rather than each starting a background drain that would
// hold the drain lock while the daemon's own sweeps, and the failures they
// record, bow out. Under --no-daemon no daemon drains, so the steps still
// drain for themselves.
export const SETUP_DAEMON_DRAINS_ENV = "PRIM_SETUP_DAEMON_DRAINS";

/**
 * How setup runs one step. Capturing a step means we only want its machine
 * STDOUT (JSON) — a status/auth probe. Its human STDERR is silenced so
 * status-line noise ("gate ✓ · capture ✗ …") doesn't interleave into the
 * setup trail. Every step carries SETUP_ORCHESTRATOR_ENV, and
 * SETUP_DAEMON_DRAINS_ENV exactly when setup starts the daemon.
 */
export function setupStepSpawnOptions(
  capture: boolean,
  env: NodeJS.ProcessEnv = process.env,
  options: { startsDaemon?: boolean } = {},
): SpawnSyncOptionsWithStringEncoding {
  return {
    env: {
      ...env,
      [SETUP_ORCHESTRATOR_ENV]: "1",
      // Unset rather than inherited when this setup starts no daemon.
      [SETUP_DAEMON_DRAINS_ENV]: options.startsDaemon === true ? "1" : undefined,
    },
    stdio: capture ? ["inherit", "pipe", "ignore"] : "inherit",
    encoding: "utf-8",
  };
}

export type SetupAgent = "claude" | "codex" | "cursor" | "hermes";
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
  cursor: "Cursor integration",
  hermes: "Hermes integration",
};

export function planSetupSteps(opts: {
  agent: SetupAgent;
  daemon: boolean;
  scope: SetupScope;
  /** Opt in to git's global hooks, which reach every repository on the machine. */
  globalHooksPath?: boolean;
}): SetupStep[] {
  const scopeArgs = opts.scope === "user" ? ["--scope", "user"] : [];
  // Hermes config is global-only: it has no project/user layer, so don't
  // forward a scope flag (hermes install hard-errors on --scope project).
  // Every other agent gets its scope explicitly: their install defaults differ.
  const sessionArgs =
    opts.agent === "hermes"
      ? [opts.agent, "install"]
      : [opts.agent, "install", "--scope", opts.scope];
  const steps: SetupStep[] = [
    {
      key: "session",
      label: SESSION_LABELS[opts.agent],
      args: sessionArgs,
      required: true,
    },
  ];
  if (opts.daemon) {
    // The supervised daemon owns the continuous, durable journal drain. Setup
    // must not claim completion when the user asked for that guarantee but the
    // service failed to become healthy; --no-daemon is the explicit opt-out.
    steps.push({
      key: "daemon",
      label: "Companion daemon",
      args: ["daemon", "start"],
      required: true,
    });
  } else {
    // Persist the opt-out, not merely the absence of a start attempt. The
    // SessionStart self-healer respects the same explicit-stop marker, so it
    // cannot silently undo `setup --no-daemon` on the next agent session.
    steps.push({
      key: "daemon-opt-out",
      label: "Daemon opt-out",
      args: ["daemon", "stop"],
      required: true,
    });
  }
  // Git hooks: project scope wires this repo. User scope leaves git's global
  // config alone unless asked: a global core.hooksPath reroutes every
  // repository on the machine, and setup usually runs unattended in an agent
  // session. The enable step below wires this repo either way.
  if (opts.scope === "project") {
    steps.push({ key: "hooks", label: "Git hooks", args: ["hooks", "install"], required: true });
  } else if (opts.globalHooksPath) {
    steps.push({
      key: "hooks",
      label: "Git hooks (global)",
      args: ["hooks", "install", "--scope", "user", "--global-hooks-path"],
      required: true,
    });
  }
  // Guidance follows the agent: native skills for Claude/Cursor and rules files
  // for Codex/Hermes. Passing --agent lets `skill install` pick it
  // deterministically — vs. auto-detection, which could land a non-Claude agent
  // on CLAUDE.md (its no-candidate default). Unlike the session step, the skill
  // takes `--scope user` for every agent (hermes included: ~/.hermes/.hermes.md).
  const skillArgs = ["skill", "install", "--agent", opts.agent, ...scopeArgs];
  steps.push({ key: "skill", label: "Agent skill", args: skillArgs, required: true });
  // Activation also verifies the effective post-commit destination and
  // resolves the repository binding when one is available. It is required at
  // both scopes: setup must not claim success for an uncovered checkout.
  steps.push({
    key: "enable",
    label: "Activate this repo",
    args: ["enable"],
    required: true,
  });
  if (opts.daemon) {
    // Doctor must observe the final installed + enabled state. In particular,
    // setup cannot report success while a local core.hooksPath shadows Prim.
    // A reinstall or re-auth can inherit Moves queued while capture was not
    // delivering; they cannot have met the 30s SLA yet. --expect-backlog
    // reports a backlog the daemon is draining as a warning, but only once
    // the daemon is live, current, authenticated, and heartbeating; buckets it
    // holds back and failures it recorded without progress still fail.
    steps.push({
      key: "health",
      label: "Capture health",
      args: ["doctor", "--expect-backlog"],
      required: true,
    });
  }
  return steps;
}

type RunFn = (args: string[], capture?: boolean) => { code: number; stdout: string };

export type SetupCommandDependencies = {
  run?: RunFn;
  note?: (message: string) => void;
  exit?: (code: number) => void;
};

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
 * Whether a pre-commit hook runs prim: the managed block (every release since
 * the v1 contract, whose block execs the entrypoint by hook name) or an older
 * direct `prim-pre-commit` call.
 */
export function preCommitRunsPrim(content: string): boolean {
  return content.includes("# >>> prim pre-commit hook >>>") || content.includes("prim-pre-commit");
}

/**
 * A project pre-commit that runs prim double-fires only beside prim's global
 * hooks. Without them it is how the repository is wired, and removing it would
 * drop the decision check.
 */
export function projectHooksConflict(
  globalHooksActive: boolean,
  preCommit: string | undefined,
): boolean {
  return globalHooksActive && preCommit !== undefined && preCommitRunsPrim(preCommit);
}

/**
 * Whether `prim enable` can wire the repository at `root`: Git runs its hooks
 * from a place prim may write (the repository's own hooks, a hooks dir inside
 * it, or prim's dir), not a dir that other repositories share. Undefined
 * outside a repository.
 */
export function enableWiresRepository(root: string | null | undefined): boolean | undefined {
  if (!root) return undefined;
  try {
    // Manual mode: enable writes no hook file, so it wires nothing.
    if (gitHooksMode({ cwd: root }) === "manual") return undefined;
    return resolveEffectiveGitHook("post-commit", root).location !== "external";
  } catch {
    return undefined;
  }
}

/** Setup's trail line for git hooks at user scope, without --global-hooks-path. */
export function setupGitHooksNote(plan: GlobalHooksPlan, wiresThisRepository?: boolean): string {
  // A repository whose hooks Git runs from inside it (Husky's own
  // core.hooksPath, say) never runs the shared dir: `prim enable` wires it
  // without any consent.
  if (wiresThisRepository === true && plan.action === "add_to_dir") {
    return `git hooks · Git runs this repository's hooks from inside it, so \`prim enable\` wires it; other repositories may run ${plan.global}, which prim edits only with --global-hooks-path, after asking the user`;
  }
  if (wiresThisRepository === true && plan.action === "system_declined") {
    return `git hooks · Git runs this repository's hooks from inside it, so \`prim enable\` wires it; other repositories may run the system hooks dir ${plan.system}, which prim never edits`;
  }
  switch (plan.action) {
    case "refresh":
      return "git hooks · prim's global hooks stay active; `prim enable` refreshes them";
    case "present_in_dir":
      return `git hooks · prim's hooks are already in your global hooks dir ${plan.global}`;
    case "add_to_dir":
      return `git hooks · your global core.hooksPath (${plan.global}) runs every repository's hooks, so \`prim enable\` cannot wire this repository without it; add prim there with --global-hooks-path, after asking the user`;
    case "system_declined":
      return `git hooks · the system core.hooksPath (${plan.system}) runs every repository's hooks, so \`prim enable\` cannot wire this repository: place \`prim hooks snippet <hook>\` there, or, after asking the user, run \`prim hooks install --scope user --global-hooks-path --force\` (its hooks stop firing)`;
    case "manual":
      return "git hooks · prim.gitHooks=manual: prim writes no hook files; wire them with `prim hooks snippet <hook>`";
    default:
      return "git hooks · wired per repository by `prim enable`; git's global hooks are untouched (opt in with --global-hooks-path)";
  }
}

/**
 * Detect project-scoped prim config lingering in the current repo — it would
 * double-fire alongside a fresh user-scope install. Reuses the existing status
 * subcommands (their JSON is on STDOUT) for the session + rules file, and a
 * direct read for the git hook (there is no `hooks status`). Every probe is
 * fail-soft: a missing/erroring signal is simply "not present".
 */
function detectProjectConflicts(
  agent: SetupAgent,
  run: RunFn,
  globalHooksActive: boolean,
): string[] {
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
  let preCommit: string | undefined;
  try {
    const root = gitToplevel();
    const path = root && join(root, ".git", "hooks", "pre-commit");
    if (path && existsSync(path)) preCommit = readFileSync(path, "utf-8");
  } catch {
    // not a repo / no hook → absent
  }
  if (projectHooksConflict(globalHooksActive, preCommit)) conflicts.push(CONFLICT_HOOKS);

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
  if (env.CURSOR_AGENT) {
    return "cursor";
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

export type SetupAuthStatus = "valid" | "invalid" | "unreachable";

/** Interpret the auth command's stable tri-state protocol, with old-client fallback. */
export function parseSetupAuthStatus(result: { code: number; stdout: string }): SetupAuthStatus {
  try {
    const parsed = JSON.parse(result.stdout || "{}") as {
      status?: unknown;
      authenticated?: unknown;
    };
    if (parsed.status === "valid" || parsed.authenticated === true) return "valid";
    if (parsed.status === "unreachable") return "unreachable";
    if (parsed.status === "invalid") return "invalid";
  } catch {
    // Fall through to the exit-code contract for malformed/old output.
  }
  return result.code === EXIT_USAGE ? "unreachable" : "invalid";
}

type SetupCommandOptions = {
  agent?: string;
  scope: string;
  migrate?: boolean;
  daemon: boolean;
  globalHooksPath?: boolean;
};

export function registerSetupCommand(
  program: Command,
  dependencies: SetupCommandDependencies = {},
): void {
  program
    .command("setup")
    .description(
      "Install everything in one shot (auth, session + git hooks, daemon, skill, welcome)",
    )
    .option("--agent <agent>", "claude, codex, cursor, or hermes (auto-detected when omitted)")
    .option(
      "--scope <scope>",
      "user (default — agent integration and skill for every repo; git hooks per repo via enable) or project (this repo only)",
      "user",
    )
    .option(
      "--global-hooks-path",
      "with the default user scope, also change git's global hooks so prim's hooks run in every repository",
    )
    .option(
      "--migrate",
      "with the default user scope, remove any project-scoped prim config in this repo (else just warn)",
    )
    .option("--no-daemon", "stop and disable the companion daemon")
    .action((opts: SetupCommandOptions) => {
      // Explicit --agent wins and is typo-checked (usage error → exit 2, the
      // CLI's convention for rejected input); when omitted, infer from the env so
      // a bare `prim setup` wires the integration matching the calling agent.
      const { agent: agentInput, detected } = resolveAgent(opts.agent, process.env);
      if (
        agentInput !== "claude" &&
        agentInput !== "codex" &&
        agentInput !== "cursor" &&
        agentInput !== "hermes"
      ) {
        process.stderr.write(
          `[prim] unknown --agent "${agentInput}" (expected claude, codex, cursor, or hermes)\n`,
        );
        (dependencies.exit ?? process.exit)(EXIT_USAGE);
        return;
      }
      if (opts.scope !== "project" && opts.scope !== "user") {
        process.stderr.write(`[prim] unknown --scope "${opts.scope}" (expected project or user)\n`);
        (dependencies.exit ?? process.exit)(EXIT_USAGE);
        return;
      }
      if (opts.globalHooksPath && opts.scope !== "user") {
        process.stderr.write("[prim] --global-hooks-path applies only with --scope user\n");
        (dependencies.exit ?? process.exit)(EXIT_USAGE);
        return;
      }
      const agent: SetupAgent = agentInput;
      const scope: SetupScope = opts.scope;
      const self = process.argv[1];
      // Root program's interactive-gating globals (-y / --non-interactive),
      // forwarded to the enable step below: setup spawns steps as child processes
      // that don't inherit the parent's parsed flags, so the repository-binding
      // prompt would otherwise never see them.
      const globals = program.optsWithGlobals();

      const run =
        dependencies.run ??
        ((args: string[], capture = false): { code: number; stdout: string } => {
          const r = spawnSync(
            process.execPath,
            [self, ...args],
            setupStepSpawnOptions(capture, process.env, { startsDaemon: opts.daemon }),
          );
          return { code: r.status ?? 1, stdout: capture ? (r.stdout ?? "") : "" };
        });

      const results: Record<string, StepResult> = {};
      const note =
        dependencies.note ??
        ((msg: string): void => {
          process.stderr.write(`[prim] ${msg}\n`);
        });
      const exit = dependencies.exit ?? process.exit;
      // Surface an inferred agent — the install it wires depends on it, and the
      // user can correct a wrong guess with --agent. The claude fallback is the
      // historical default, so it stays silent.
      if (detected && agent !== "claude") {
        note(`agent · detected ${agent} session (override with --agent <agent>)`);
      }

      // 0 · Verify auth before changing any integration or permission state.
      // A transport/backend outage is indeterminate, not invalid credentials:
      // abort without opening a browser or partially installing setup.
      let authStatus = parseSetupAuthStatus(run(["auth", "status", "--json"], true));
      if (authStatus === "unreachable") {
        note("auth · verification unavailable; no setup changes were made");
        exit(EXIT_USAGE);
        return;
      }
      if (authStatus === "invalid") {
        note("auth · opening browser to authenticate…");
        const login = run(["auth", "login"]);
        if (login.code !== 0) {
          note("auth · login failed; no integration changes were made");
          exit(EXIT_INCOMPLETE);
          return;
        }
        authStatus = parseSetupAuthStatus(run(["auth", "status", "--json"], true));
        if (authStatus !== "valid") {
          note(
            authStatus === "unreachable"
              ? "auth · login completed but verification is unavailable; no integration changes were made"
              : "auth · login did not produce valid credentials; no integration changes were made",
          );
          exit(authStatus === "unreachable" ? EXIT_USAGE : EXIT_INCOMPLETE);
          return;
        }
      } else {
        note("auth · already authenticated");
      }
      results.auth = "ok";

      // 1 · Pre-authorize prim at USER scope after verified auth.
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

      // 2..N · the mutating install steps. Activation and health are deliberately
      // deferred until after optional migration, which may remove project hook
      // bytes. Activation then repairs and verifies the final effective hook even
      // for --no-daemon setups, where no doctor step is planned.
      const setupSteps = planSetupSteps({
        agent,
        daemon: opts.daemon,
        scope,
        globalHooksPath: opts.globalHooksPath === true,
      });
      for (const step of setupSteps.filter(
        (candidate) => candidate.key !== "enable" && candidate.key !== "health",
      )) {
        note(`${step.label} · installing…`);
        const { code } = run(step.args);
        // A declined global-hooks step (manual mode, a system hooksPath) says
        // why on STDERR and is a skip, not an install.
        results[step.key] =
          code === 0
            ? "ok"
            : code === EXIT_GLOBAL_HOOKS_NOT_INSTALLED && step.key === "hooks"
              ? "skipped"
              : step.required
                ? "failed"
                : "skipped";
      }

      if (scope === "user" && !opts.globalHooksPath) {
        note(setupGitHooksNote(planGlobalHooks(), enableWiresRepository(gitToplevel())));
      }

      // N+1 · Migrate — with the (default) user scope, a lingering PROJECT-scoped
      // install in this repo double-fires alongside the user-scope one. Detect it;
      // with --migrate remove it via the existing uninstall subcommands, else warn
      // with the one-flag remedy so the user opts in explicitly.
      if (scope === "user") {
        const conflicts = detectProjectConflicts(agent, run, globalHooksPathIsPrims());
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

      // Activation must observe and repair the actual final hook state, including
      // migration. It is required even when --no-daemon omits doctor.
      const enableStep = setupSteps.find((candidate) => candidate.key === "enable");
      if (enableStep) {
        note(`${enableStep.label} · installing…`);
        const enableArgs = [
          ...enableStep.args,
          ...(globals.yes ? ["--yes"] : []),
          ...(globals.nonInteractive ? ["--non-interactive"] : []),
        ];
        const { code } = run(enableArgs);
        results[enableStep.key] = code === 0 ? "ok" : enableStep.required ? "failed" : "skipped";
      }

      // Doctor verifies that same final state when the daemon was requested.
      const healthStep = setupSteps.find((candidate) => candidate.key === "health");
      if (healthStep) {
        note(`${healthStep.label} · verifying…`);
        const { code } = run(healthStep.args);
        results[healthStep.key] = code === 0 ? "ok" : healthStep.required ? "failed" : "skipped";
      }

      // Final · welcome — its output (orientation + any seeding guidance)
      // streams through inherited stdio BEFORE we read the exit code, so
      // the required final deliverable is always shown. A non-zero (it normally
      // exits 0) is surfaced as `failed` — which, like any required step, flips
      // the overall exit to incomplete — rather than silently reported as ok.
      note("welcome");
      results.welcome = run(["welcome", "--agent", agent]).code === 0 ? "ok" : "failed";

      const failed = Object.entries(results)
        .filter(([, v]) => v === "failed")
        .map(([k]) => k);
      const trail = Object.entries(results)
        .map(([k, v]) => `${k}:${v}`)
        .join(" · ");
      note(
        `setup ${failed.length === 0 ? "complete" : `incomplete (failed: ${failed.join(", ")})`} — ${trail}`,
      );
      exit(failed.length === 0 ? 0 : EXIT_INCOMPLETE);
    });
}
