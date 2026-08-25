/**
 * `prim uninstall` — remove deterministic integration and runtime surfaces.
 *
 * Existing uninstall subcommands remain the ownership authorities for agent
 * and Git configuration. This command composes them, stops the daemon first,
 * and contracts immutable runtime bytes only after every integration removal
 * succeeds. Credentials, pending journals, repository bindings, and skill
 * guidance (whose target cannot be inferred unambiguously) are retained.
 */

import { spawnSync } from "node:child_process";
import type { Command } from "commander";
import { assertOwnedDaemonRuntime, removeDaemonRuntime } from "../daemon/launchd.js";
import { boundedHealthError } from "../lib/ansi.js";
import { gitToplevel } from "../lib/git.js";
import {
  assertOwnedHookRuntime,
  hookRuntimePaths,
  removeHookRuntime,
} from "../lib/hook-runtime.js";

const EXIT_INCOMPLETE = 1;
const CHILD_TIMEOUT_MS = 30_000;
export const UNINSTALL_ORCHESTRATOR_ENV = "PRIM_UNINSTALL_ORCHESTRATOR";

export type UninstallStep = {
  key: string;
  label: string;
  args: string[];
};

export type UninstallRunResult = {
  code: number;
  stdout?: string;
  stderr: string;
};

export type RuntimeRemovalResult =
  | { status: "removed"; hookRuntimeChanged: boolean; daemonRuntimeChanged: boolean }
  | { status: "retained"; reason: string }
  | {
      status: "partial";
      hookRuntime: "removed" | "unchanged" | "unknown";
      daemonRuntime: "removed" | "unchanged" | "unknown";
      reason: string;
    };

export type RuntimeRemovalDependencies = {
  assertHookRuntime?: () => void;
  assertDaemonRuntime?: () => void;
  removeHookRuntime?: () => { changed: boolean };
  removeDaemonRuntime?: () => Promise<{ changed: boolean }>;
};

export type UninstallCommandDependencies = {
  inRepository?: () => boolean;
  run?: (args: string[]) => UninstallRunResult;
  removeRuntimes?: () => Promise<RuntimeRemovalResult>;
  note?: (message: string) => void;
  write?: (value: string) => void;
  exit?: (code: number) => void;
};

export function planUninstallSteps(inRepository: boolean): UninstallStep[] {
  const project = inRepository
    ? [
        {
          key: "claude-project",
          label: "Claude Code project integration",
          args: ["claude", "uninstall", "--scope", "project"],
        },
        {
          key: "codex-project",
          label: "Codex project integration",
          args: ["codex", "uninstall", "--scope", "project"],
        },
        {
          key: "hooks-project",
          label: "project Git hooks",
          args: ["hooks", "uninstall", "--scope", "project"],
        },
      ]
    : [];
  return [
    { key: "daemon", label: "companion daemon", args: ["daemon", "stop"] },
    ...project,
    {
      key: "claude-user",
      label: "Claude Code user integration",
      args: ["claude", "uninstall", "--scope", "user"],
    },
    {
      key: "codex-user",
      label: "Codex user integration",
      args: ["codex", "uninstall", "--scope", "user"],
    },
    { key: "hermes-user", label: "Hermes integration", args: ["hermes", "uninstall"] },
    {
      key: "hooks-user",
      label: "user Git hooks",
      args: ["hooks", "uninstall", "--scope", "user"],
    },
  ];
}

export function uninstallStepSucceeded(step: UninstallStep, result: UninstallRunResult): boolean {
  if (result.code !== 0) return false;
  if (step.key === "daemon") {
    try {
      const parsed = JSON.parse(result.stdout ?? "") as Record<string, unknown>;
      return (
        parsed.verified === true &&
        ((parsed.stopped === true && parsed.wasRunning === true) ||
          (parsed.stopped === false && parsed.wasRunning === false && parsed.absent === true))
      );
    } catch {
      return false;
    }
  }
  if (
    !step.key.startsWith("claude-") &&
    !step.key.startsWith("codex-") &&
    step.key !== "hermes-user"
  ) {
    return true;
  }
  try {
    const parsed = JSON.parse(result.stdout ?? "") as Record<string, unknown>;
    if (step.key.startsWith("claude-")) {
      return (
        parsed.gate === false &&
        parsed.capture === false &&
        parsed.feedback === false &&
        parsed.statusline === false
      );
    }
    return parsed.gate === false && parsed.capture === false;
  } catch {
    return false;
  }
}

/**
 * Contract both runtime surfaces only after both ownership checks pass.
 *
 * A removal error after either delete begins is reported as partial rather
 * than claiming that both surfaces were retained; rerunning is safe and will
 * contract any still-recognized runtime.
 */
export async function removeOwnedRuntimes(
  dependencies: RuntimeRemovalDependencies = {},
): Promise<RuntimeRemovalResult> {
  const assertHookRuntime =
    dependencies.assertHookRuntime ?? (() => assertOwnedHookRuntime(hookRuntimePaths()));
  const assertDaemonRuntime =
    dependencies.assertDaemonRuntime ?? (() => assertOwnedDaemonRuntime({}));
  const removeHook = dependencies.removeHookRuntime ?? (() => removeHookRuntime());
  const removeDaemon = dependencies.removeDaemonRuntime ?? (() => removeDaemonRuntime());

  try {
    assertHookRuntime();
    assertDaemonRuntime();
  } catch (error) {
    return {
      status: "retained",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  let hookRuntime: { changed: boolean };
  try {
    hookRuntime = removeHook();
  } catch (error) {
    return {
      status: "partial",
      hookRuntime: "unknown",
      daemonRuntime: "unchanged",
      reason: error instanceof Error ? error.message : String(error),
    };
  }

  try {
    const daemonRuntime = await removeDaemon();
    return {
      status: "removed",
      hookRuntimeChanged: hookRuntime.changed,
      daemonRuntimeChanged: daemonRuntime.changed,
    };
  } catch (error) {
    return {
      status: "partial",
      hookRuntime: hookRuntime.changed ? "removed" : "unchanged",
      daemonRuntime: "unknown",
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function registerUninstallCommand(
  program: Command,
  dependencies: UninstallCommandDependencies = {},
): void {
  program
    .command("uninstall")
    .description("Remove Prim integrations, stop the daemon, and delete recognized runtime bytes")
    .action(async () => {
      const self = process.argv[1];
      const run =
        dependencies.run ??
        ((args: string[]): UninstallRunResult => {
          const result = spawnSync(process.execPath, [self, ...args], {
            encoding: "utf8",
            env: { ...process.env, [UNINSTALL_ORCHESTRATOR_ENV]: "1" },
            stdio: ["ignore", "pipe", "pipe"],
            timeout: CHILD_TIMEOUT_MS,
          });
          const detail = result.error?.message ?? result.stderr ?? "";
          return {
            code: result.status ?? EXIT_INCOMPLETE,
            stdout: result.stdout ?? "",
            stderr: detail,
          };
        });
      const removeRuntimes = dependencies.removeRuntimes ?? (() => removeOwnedRuntimes());
      const note =
        dependencies.note ??
        ((message: string) => {
          process.stderr.write(`[prim] ${message}\n`);
        });
      const write = dependencies.write ?? ((value: string) => process.stdout.write(value));
      const exit =
        dependencies.exit ??
        ((code: number) => {
          process.exitCode = code;
        });
      const inRepository = (dependencies.inRepository ?? (() => gitToplevel() !== null))();

      const steps = planUninstallSteps(inRepository);
      const results: Array<{ key: string; ok: boolean }> = [];
      for (const step of steps) {
        note(`uninstall · ${step.label}…`);
        const result = run(step.args);
        const ok = uninstallStepSucceeded(step, result);
        results.push({ key: step.key, ok });
        if (!ok) {
          const detail = boundedHealthError(result.stderr);
          note(`uninstall · ${step.label} failed${detail ? `: ${detail}` : ""}`);
        }
      }

      const failed = results.filter((result) => !result.ok).map((result) => result.key);
      let runtime: RuntimeRemovalResult;
      if (failed.length > 0) {
        runtime = {
          status: "retained",
          reason: "one or more integration removals failed",
        };
        note("uninstall · runtime retained because an integration removal failed");
      } else {
        try {
          runtime = await removeRuntimes();
          if (runtime.status === "removed") {
            note("uninstall · recognized runtime state removed");
          } else {
            failed.push("runtime");
            const state =
              runtime.status === "partial"
                ? ` (${runtime.hookRuntime} hook runtime; ${runtime.daemonRuntime} daemon runtime)`
                : "";
            note(`uninstall · runtime removal incomplete${state}: ${runtime.reason}`);
          }
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failed.push("runtime");
          runtime = {
            status: "partial",
            hookRuntime: "unknown",
            daemonRuntime: "unknown",
            reason: detail,
          };
          note(`uninstall · runtime removal incomplete (unknown state): ${detail}`);
        }
      }

      const complete = failed.length === 0;
      const result = {
        uninstalled: complete,
        projectScopeChecked: inRepository,
        steps: results,
        runtime,
        preserved: [
          "credentials",
          "pending journals",
          "repository bindings",
          "agent skill guidance",
        ],
      };
      write(`${JSON.stringify(result, null, 2)}\n`);
      note(
        complete
          ? "uninstall complete · credentials and pending journals preserved"
          : `uninstall incomplete · failed: ${failed.join(", ")}`,
      );
      exit(complete ? 0 : EXIT_INCOMPLETE);
    });
}
