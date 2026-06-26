/**
 * `prim setup` — the whole install in one user-run command.
 *
 * Runs the same steps an agent would drive from `setup.md`, but as a single
 * command a human invokes directly: auth (login only if needed) → session
 * integration (Claude Code or Codex) → companion daemon → git hooks → agent
 * skill → welcome. It orchestrates by re-invoking the prim binary's own
 * subcommands, so every step behaves byte-for-byte like running it by hand —
 * including the interactive browser login — with no logic duplicated here.
 *
 * Why a one-shot exists: when an agent fetches `setup.md` and tries to run the
 * steps, its harness reserves persistence (git hooks, a daemon) for a human and
 * blocks externally-sourced commands. A single command the *user* runs sidesteps
 * that entirely — the invocation originates from them, and persistence is
 * authorized by construction.
 *
 * AX: each step's own output streams through (STDERR human / STDOUT machine);
 * this wrapper adds a one-line-per-step progress trail on STDERR and a final
 * status line. Idempotent — every underlying step is, so re-running is safe.
 */

import { spawnSync } from "node:child_process";
import type { Command } from "commander";

const EXIT_INCOMPLETE = 1;
const EXIT_USAGE = 2;

export type SetupAgent = "claude" | "codex";
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
export function planSetupSteps(opts: {
  agent: SetupAgent;
  daemon: boolean;
  scope: SetupScope;
}): SetupStep[] {
  const scopeArgs = opts.scope === "user" ? ["--scope", "user"] : [];
  const steps: SetupStep[] = [
    {
      key: "session",
      label: opts.agent === "codex" ? "Codex integration" : "Claude Code integration",
      args: [opts.agent, "install", ...scopeArgs],
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
  steps.push({ key: "skill", label: "Agent skill", args: ["skill", "install"], required: true });
  return steps;
}

type StepResult = "ok" | "failed" | "skipped";

export function registerSetupCommand(program: Command): void {
  program
    .command("setup")
    .description(
      "Install everything in one shot (auth, session + git hooks, daemon, skill, welcome)",
    )
    .option("--agent <agent>", "claude or codex", "claude")
    .option("--scope <scope>", "project or user (session integration)", "project")
    .option("--no-daemon", "skip starting the companion daemon")
    .action((opts: { agent: string; scope: string; daemon: boolean }) => {
      // Fail loud on a typo rather than silently installing the wrong thing —
      // the same posture resolveScope takes for `claude install --scope`.
      if (opts.agent !== "claude" && opts.agent !== "codex") {
        process.stderr.write(`[prim] unknown --agent "${opts.agent}" (expected claude or codex)\n`);
        process.exit(EXIT_USAGE);
      }
      if (opts.scope !== "project" && opts.scope !== "user") {
        process.stderr.write(`[prim] unknown --scope "${opts.scope}" (expected project or user)\n`);
        process.exit(EXIT_USAGE);
      }
      const agent: SetupAgent = opts.agent;
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

      // Final · welcome — its own output (orientation + any "Your turn" seeding
      // prompt) streams straight through as the closing message. It's the
      // required final deliverable, so a non-zero (it normally exits 0) is
      // surfaced in the trail rather than silently reported as ok.
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
