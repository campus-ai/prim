import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerActivationCommands } from "../commands/activation.js";
import { registerAuthCommands } from "../commands/auth.js";
import { registerClaudeCommands } from "../commands/claude-install.js";
import { registerCodexCommands } from "../commands/codex-install.js";
import { registerCursorCommands } from "../commands/cursor-install.js";
import { registerDaemonCommands } from "../commands/daemon.js";
import { registerDecisionsCommands } from "../commands/decisions.js";
import { registerDoctorCommands } from "../commands/doctor.js";
import { registerGithubCommands } from "../commands/github.js";
import { registerHermesCommands } from "../commands/hermes-install.js";
import { registerHooksCommands } from "../commands/hooks.js";
import { registerMovesCommands } from "../commands/moves.js";
import { registerReconcileCommands } from "../commands/reconcile.js";
import { registerSessionCommands } from "../commands/session.js";
import {
  SETUP_DAEMON_DRAINS_ENV,
  SETUP_ORCHESTRATOR_ENV,
  registerSetupCommand,
} from "../commands/setup.js";
import { registerSkillCommands } from "../commands/skill.js";
import { registerStatuslineCommands } from "../commands/statusline.js";
import { UNINSTALL_ORCHESTRATOR_ENV, registerUninstallCommand } from "../commands/uninstall.js";
import { registerWelcomeCommand } from "../commands/welcome.js";
import {
  DAEMON_HEAL_COMMANDS,
  mayHealDaemon,
  runStartupBackgroundWork,
} from "./startup-background.js";
import { UNATTENDED_ENV } from "./unattended.js";

function work() {
  return { notify: vi.fn(), flush: vi.fn(), healDaemon: vi.fn() };
}

describe("runStartupBackgroundWork", () => {
  it.each([{ argv: ["--yes", "uninstall"] }, { argv: ["--non-interactive", "uninstall"] }])(
    "keeps $argv offline before notifier, journal drain, or daemon heal",
    ({ argv }) => {
      const background = work();

      runStartupBackgroundWork(argv, {}, background);

      expect(background.notify).not.toHaveBeenCalled();
      expect(background.flush).not.toHaveBeenCalled();
      expect(background.healDaemon).not.toHaveBeenCalled();
    },
  );

  it("keeps orchestrated child commands offline", () => {
    const background = work();

    runStartupBackgroundWork(["daemon", "stop"], { [UNINSTALL_ORCHESTRATOR_ENV]: "1" }, background);
    runStartupBackgroundWork(["auth", "status"], { [UNINSTALL_ORCHESTRATOR_ENV]: "1" }, background);

    expect(background.notify).not.toHaveBeenCalled();
    expect(background.flush).not.toHaveBeenCalled();
    expect(background.healDaemon).not.toHaveBeenCalled();
  });

  it("skips only the redundant drain for an explicit moves flush", () => {
    const background = work();

    runStartupBackgroundWork(["--yes", "moves", "flush"], {}, background);

    expect(background.notify).toHaveBeenCalledOnce();
    expect(background.flush).not.toHaveBeenCalled();
    expect(background.healDaemon).toHaveBeenCalledOnce();
  });

  const daemonSetupStep = { [SETUP_ORCHESTRATOR_ENV]: "1", [SETUP_DAEMON_DRAINS_ENV]: "1" };

  it.each([
    {
      label: "the steps of a setup that starts the daemon",
      argv: ["doctor", "--expect-backlog"],
      env: daemonSetupStep,
    },
    {
      label: "the steps of a setup that starts the daemon",
      argv: ["daemon", "start"],
      env: daemonSetupStep,
    },
    {
      label: "a setup that starts the daemon",
      argv: ["--yes", "setup", "--agent", "codex"],
      env: {},
    },
  ])("leaves the drain to the daemon for $label ($argv)", ({ argv, env }) => {
    // A background drain holding the lock would make the daemon's sweeps bow
    // out unrecorded, so setup's doctor could never see a delivery failure.
    const background = work();

    runStartupBackgroundWork(argv, env, background);

    expect(background.notify).toHaveBeenCalledOnce();
    expect(background.flush).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the steps of a --no-daemon setup",
      argv: ["daemon", "stop"],
      env: { [SETUP_ORCHESTRATOR_ENV]: "1" },
    },
    {
      label: "the steps of a --no-daemon setup",
      argv: ["hooks", "install"],
      env: { [SETUP_ORCHESTRATOR_ENV]: "1" },
    },
    {
      label: "a --no-daemon setup",
      argv: ["--yes", "setup", "--agent", "codex", "--no-daemon"],
      env: {},
    },
  ])("still drains for $label ($argv), since no daemon will", ({ argv, env }) => {
    const background = work();

    runStartupBackgroundWork(argv, env, background);

    expect(background.notify).toHaveBeenCalledOnce();
    expect(background.flush).toHaveBeenCalledOnce();
  });

  it.each([["claude", "preauth"], ["daemon", "start"], ["doctor"], ["moves", "status"]])(
    "hands %s's opportunistic drain off synchronously, never awaiting it",
    (...argv) => {
      const background = work();

      // Returning nothing (not a promise) is the contract: the command must not
      // be able to wait on, or be kept alive by, the drain.
      expect(runStartupBackgroundWork(argv, {}, background)).toBeUndefined();
      expect(background.flush).toHaveBeenCalledOnce();
      expect(background.flush).toHaveBeenCalledWith();
    },
  );

  it("heals from an allowlisted command and keeps the other startup work", () => {
    const background = work();

    runStartupBackgroundWork(["decisions", "recent"], {}, background);

    expect(background.notify).toHaveBeenCalledOnce();
    expect(background.flush).toHaveBeenCalledOnce();
    expect(background.healDaemon).toHaveBeenCalledOnce();
  });

  it("keeps the other startup work for a command that may not heal", () => {
    const background = work();

    runStartupBackgroundWork(["doctor"], {}, background);

    expect(background.notify).toHaveBeenCalledOnce();
    expect(background.flush).toHaveBeenCalledOnce();
    expect(background.healDaemon).not.toHaveBeenCalled();
  });
});

describe("mayHealDaemon", () => {
  it.each([
    ["auth", "login"],
    ["auth", "status", "--json"],
    ["--yes", "--non-interactive", "decisions", "create"],
    ["decisions", "show", "dec_123"],
    ["reconcile", "dec_123"],
    ["github", "connect"],
    ["enable"],
    ["moves", "status"],
    // A person draining by hand heals; hook drains are marked unattended.
    ["moves", "flush"],
    ["session", "start", "session-1"],
    ["claude", "install", "--scope", "user"],
    ["claude", "preauth"],
    ["codex", "status"],
    ["cursor", "install"],
    ["hermes", "install"],
    ["hooks", "install"],
    ["skill", "install", "--agent", "claude"],
    ["welcome"],
  ])("lets attended `prim %s` heal", (...argv) => {
    expect(mayHealDaemon(argv, {})).toBe(true);
  });

  it.each([
    // Explicit management, diagnostics, setup's own daemon step, the editor
    // render loop, and printing only.
    ["daemon", "status"],
    ["daemon", "ensure", "--latest-bootstrap"],
    ["daemon", "restart"],
    ["--yes", "doctor"],
    ["setup", "--no-daemon"],
    ["statusline"],
    ["help", "decisions"],
    [],
    ["--version"],
    ["--help"],
    ["decisions", "--help"],
    ["decisions", "recent", "-h"],
    ["welcome", "--help"],
    // A group without a subcommand only prints its help.
    ["decisions"],
    ["auth"],
    // Removing Primitive is no time to upgrade it.
    ["uninstall"],
    ["disable"],
    ["claude", "uninstall"],
    ["hooks", "uninstall"],
    ["skill", "uninstall", "--agent", "codex"],
    // Unknown commands and subcommands fail closed.
    ["frobnicate"],
    ["decisions", "frobnicate"],
  ])("never heals from `prim %s`", (...argv) => {
    expect(mayHealDaemon(argv, {})).toBe(false);
  });

  it("never heals from an unattended child, whatever it runs", () => {
    const unattended = { [UNATTENDED_ENV]: "1" };

    // The Stop, post-commit, and post-rewrite hooks' drains and SessionStart's
    // repair carry the marker; so does anything they start in turn.
    expect(mayHealDaemon(["moves", "flush"], unattended)).toBe(false);
    expect(mayHealDaemon(["decisions", "recent"], unattended)).toBe(false);
  });

  it("leaves setup's child steps to setup's own daemon step", () => {
    expect(mayHealDaemon(["auth", "status", "--json"], { [SETUP_ORCHESTRATOR_ENV]: "1" })).toBe(
      false,
    );
  });
});

describe("the daemon-heal allowlist", () => {
  it("names only commands index.ts registers, and decides every root command", () => {
    // Mirrors index.ts. A stale or misspelled entry would silently never heal,
    // and a new root command must be classified here before it can heal.
    const program = new Command();
    for (const register of [
      registerAuthCommands,
      registerHooksCommands,
      registerActivationCommands,
      registerSkillCommands,
      registerMovesCommands,
      registerSessionCommands,
      registerDecisionsCommands,
      registerClaudeCommands,
      registerCodexCommands,
      registerCursorCommands,
      registerHermesCommands,
      registerDaemonCommands,
      registerGithubCommands,
      registerDoctorCommands,
      registerReconcileCommands,
      registerStatuslineCommands,
      registerWelcomeCommand,
      registerSetupCommand,
      registerUninstallCommand,
    ]) {
      register(program);
    }
    const registered = new Map(
      program.commands.map((command) => [
        command.name(),
        new Set(command.commands.map((subcommand) => subcommand.name())),
      ]),
    );
    const neverHeal = ["daemon", "disable", "doctor", "setup", "statusline", "uninstall"];

    expect([...registered.keys()].sort()).toEqual(
      [...DAEMON_HEAL_COMMANDS.keys(), ...neverHeal].sort(),
    );
    for (const [command, subcommands] of DAEMON_HEAL_COMMANDS) {
      const actual = registered.get(command) ?? new Set<string>();
      if (subcommands === "any") {
        expect(actual.size, `${command} is a leaf command`).toBe(0);
      } else {
        for (const subcommand of subcommands) {
          expect(actual.has(subcommand), `${command} ${subcommand} is registered`).toBe(true);
        }
      }
    }
  });
});
