/**
 * `prim setup` — the pure, testable seams the command action depends on: the
 * step plan (ordering, agent branch, daemon toggle, scope passthrough), agent
 * detection and resolution, and the option wiring. The action callback itself
 * spawns real subcommands and drives the browser login, so it is not unit-tested
 * here — by repo convention the agent and step choices it makes are extracted
 * into pure functions (detectAgent / resolveAgent / planSetupSteps) and pinned
 * below; only thin glue (the typo-check, the inferred-agent note) rides along.
 */

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { gitToplevel } from "../lib/git.js";
import { globalHooksPathIsPrims, planGlobalHooks } from "./hooks.js";
import {
  SETUP_DAEMON_DRAINS_ENV,
  SETUP_ORCHESTRATOR_ENV,
  detectAgent,
  enableWiresRepository,
  parseSetupAuthStatus,
  planCleanupUninstalls,
  planSetupSteps,
  preCommitRunsPrim,
  projectHooksConflict,
  registerSetupCommand,
  resolveAgent,
  setupGitHooksNote,
  setupStepSpawnOptions,
} from "./setup.js";

// Hermetic: never read the developer's real global git config.
vi.mock("./hooks.js", () => ({
  EXIT_GLOBAL_HOOKS_NOT_INSTALLED: 3,
  globalHooksPathIsPrims: vi.fn(() => false),
  planGlobalHooks: vi.fn(() => ({ action: "set_pointer" })),
}));
vi.mock("../lib/git.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/git.js")>();
  return { ...actual, gitToplevel: vi.fn(actual.gitToplevel) };
});
vi.mock("node:child_process", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:child_process")>()),
  spawnSync: vi.fn(),
}));

const keys = (opts: Parameters<typeof planSetupSteps>[0]) => planSetupSteps(opts).map((s) => s.key);

describe("planSetupSteps", () => {
  it("claude, with daemon: doctor observes the final hooks + enable state", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: true, scope: "project" });
    expect(steps.map((s) => s.key)).toEqual([
      "session",
      "daemon",
      "hooks",
      "skill",
      "enable",
      "health",
    ]);
    expect(steps[0].args).toEqual(["claude", "install", "--scope", "project"]);
    // A requested daemon is required: --no-daemon is the explicit opt-out.
    expect(steps.filter((s) => !s.required).map((s) => s.key)).toEqual([]);
  });

  it("codex: session step targets the codex integration; skill targets AGENTS.md via --agent", () => {
    const steps = planSetupSteps({ agent: "codex", daemon: true, scope: "project" });
    expect(steps[0].args).toEqual(["codex", "install", "--scope", "project"]);
    expect(steps[0].label).toMatch(/codex/i);
    expect(steps.find((s) => s.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--agent",
      "codex",
    ]);
  });

  it("cursor: user scope installs native hooks, the global skill, and CLI footer together", () => {
    const steps = planSetupSteps({ agent: "cursor", daemon: true, scope: "user" });
    expect(steps[0]).toMatchObject({
      args: ["cursor", "install", "--scope", "user"],
      label: "Cursor integration",
    });
    expect(steps.find((step) => step.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--agent",
      "cursor",
      "--scope",
      "user",
    ]);
  });

  it("--no-daemon: persists the opt-out so SessionStart cannot heal it back on", () => {
    expect(keys({ agent: "claude", daemon: false, scope: "project" })).toEqual([
      "session",
      "daemon-opt-out",
      "hooks",
      "skill",
      "enable",
    ]);
    const optOut = planSetupSteps({ agent: "claude", daemon: false, scope: "project" }).find(
      (step) => step.key === "daemon-opt-out",
    );
    expect(optOut).toMatchObject({ args: ["daemon", "stop"], required: true });
  });

  it("user scope: forwards --scope user to session and skill, and leaves git's global hooks alone", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: false, scope: "user" });
    expect(steps[0].args).toEqual(["claude", "install", "--scope", "user"]);
    // A global core.hooksPath reroutes every repository; enable wires this one.
    expect(steps.find((s) => s.key === "hooks")).toBeUndefined();
    expect(steps.find((s) => s.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--agent",
      "claude",
      "--scope",
      "user",
    ]);
  });

  it("project scope: no --scope flag on any step", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: false, scope: "project" });
    expect(steps[0].args).toEqual(["claude", "install", "--scope", "project"]);
    expect(steps.find((s) => s.key === "hooks")?.args).toEqual(["hooks", "install"]);
    expect(steps.find((s) => s.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--agent",
      "claude",
    ]);
  });

  it("user scope: sets git's global hooks only with --global-hooks-path", () => {
    const steps = planSetupSteps({
      agent: "claude",
      daemon: false,
      scope: "user",
      globalHooksPath: true,
    });
    expect(steps.find((s) => s.key === "hooks")).toMatchObject({
      args: ["hooks", "install", "--scope", "user", "--global-hooks-path"],
      required: true,
    });
    expect(steps.findIndex((s) => s.key === "hooks")).toBeLessThan(
      steps.findIndex((s) => s.key === "enable"),
    );
  });

  it("hermes: session stays global-only (no scope flag), but the skill still takes --scope user", () => {
    const steps = planSetupSteps({ agent: "hermes", daemon: false, scope: "user" });
    expect(steps[0].args).toEqual(["hermes", "install"]);
    expect(steps[0].label).toMatch(/hermes/i);
    expect(steps.find((s) => s.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--agent",
      "hermes",
      "--scope",
      "user",
    ]);
  });

  it("user scope: requires enable so setup cannot succeed with an uncovered checkout", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: false, scope: "user" });
    const enable = steps.find((s) => s.key === "enable");
    expect(enable?.args).toEqual(["enable"]);
    expect(enable?.required).toBe(true);
  });

  it("project scope: enable is required so local coverage and activation are verified", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: true, scope: "project" });
    expect(steps.find((s) => s.key === "enable")).toMatchObject({
      args: ["enable"],
      required: true,
    });
    expect(steps.at(-1)?.key).toBe("health");
  });

  it("health runs doctor with the setup-only expected-backlog relaxation, still required", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: true, scope: "user" });
    expect(steps.find((s) => s.key === "health")).toMatchObject({
      args: ["doctor", "--expect-backlog"],
      required: true,
    });
  });
});

describe("setup step processes", () => {
  it("marks every step, captured or not, as setup's own child", () => {
    expect(setupStepSpawnOptions(true, { PATH: "/bin" })).toStrictEqual({
      env: { PATH: "/bin", [SETUP_ORCHESTRATOR_ENV]: "1", [SETUP_DAEMON_DRAINS_ENV]: undefined },
      stdio: ["inherit", "pipe", "ignore"],
      encoding: "utf-8",
    });
    expect(setupStepSpawnOptions(false, { PATH: "/bin" })).toStrictEqual({
      env: { PATH: "/bin", [SETUP_ORCHESTRATOR_ENV]: "1", [SETUP_DAEMON_DRAINS_ENV]: undefined },
      stdio: "inherit",
      encoding: "utf-8",
    });
  });

  it("marks the steps as leaving the drain to the daemon only when setup starts it", () => {
    // That marker keeps each step from starting its own background journal
    // drain, so the daemon setup starts is the only drainer during setup.
    expect(setupStepSpawnOptions(true, { PATH: "/bin" }, { startsDaemon: true }).env).toEqual({
      PATH: "/bin",
      [SETUP_ORCHESTRATOR_ENV]: "1",
      [SETUP_DAEMON_DRAINS_ENV]: "1",
    });
    // A --no-daemon setup inside an outer setup step does not inherit it.
    const nested = setupStepSpawnOptions(
      false,
      { [SETUP_DAEMON_DRAINS_ENV]: "1" },
      { startsDaemon: false },
    );
    expect(nested.env?.[SETUP_DAEMON_DRAINS_ENV]).toBeUndefined();
  });

  it.each([
    { label: "--no-daemon", flags: ["--no-daemon"], drains: undefined },
    { label: "the daemon", flags: [], drains: "1" },
  ])(
    "spawns every real step of a setup with $label with the matching markers",
    async ({ flags, drains }) => {
      const spawned = vi.mocked(spawnSync);
      spawned.mockImplementation(((_command: string, args: readonly string[]) => ({
        status: 0,
        stdout: args.includes("status") ? '{"status":"valid"}' : "",
      })) as unknown as typeof spawnSync);
      const program = new Command();
      registerSetupCommand(program, { note: vi.fn(), exit: vi.fn() });

      await program.parseAsync(["setup", "--agent", "codex", "--scope", "project", ...flags], {
        from: "user",
      });

      expect(spawned.mock.calls.length).toBeGreaterThan(1);
      for (const [, , options] of spawned.mock.calls) {
        expect(options?.env?.[SETUP_ORCHESTRATOR_ENV]).toBe("1");
        expect(options?.env?.[SETUP_DAEMON_DRAINS_ENV]).toBe(drains);
      }
      spawned.mockReset();
    },
  );
});

describe("planCleanupUninstalls", () => {
  it("maps each detected conflict to its uninstall command (claude)", () => {
    expect(planCleanupUninstalls("claude", ["session", "hooks", "skill"])).toEqual([
      ["claude", "uninstall", "--scope", "project"],
      ["hooks", "uninstall"],
      ["skill", "uninstall", "--agent", "claude"],
    ]);
  });

  it("omits the session uninstall for hermes — it has no project scope", () => {
    expect(planCleanupUninstalls("hermes", ["session", "skill"])).toEqual([
      ["skill", "uninstall", "--agent", "hermes"],
    ]);
  });

  it("returns nothing when there are no conflicts", () => {
    expect(planCleanupUninstalls("codex", [])).toEqual([]);
  });
});

describe("detectAgent", () => {
  it("detects hermes from HERMES_INTERACTIVE — its interactive entrypoint sets it unconditionally", () => {
    expect(detectAgent({ HERMES_INTERACTIVE: "1" })).toBe("hermes");
  });

  it("detects Cursor Agent and keeps the Hermes marker authoritative when both exist", () => {
    expect(detectAgent({ CURSOR_AGENT: "1" })).toBe("cursor");
    expect(detectAgent({ CURSOR_AGENT: "1", HERMES_INTERACTIVE: "1" })).toBe("hermes");
  });

  it("falls back to claude when no agent signal is present (manual run — the unchanged default)", () => {
    expect(detectAgent({})).toBe("claude");
  });

  it("never mis-flags a Claude Code / Codex shell — neither carries a HERMES_ runtime marker", () => {
    expect(detectAgent({ CLAUDECODE: "1", TERM_PROGRAM: "vscode" })).toBe("claude");
  });

  it("ignores an empty HERMES_INTERACTIVE (treats blank as unset)", () => {
    expect(detectAgent({ HERMES_INTERACTIVE: "" })).toBe("claude");
  });
});

describe("resolveAgent", () => {
  it("infers the agent from the env when --agent is omitted", () => {
    expect(resolveAgent(undefined, { HERMES_INTERACTIVE: "1" })).toEqual({
      agent: "hermes",
      detected: true,
    });
  });

  it("lets an explicit --agent win and suppress detection (even inside a Hermes shell)", () => {
    expect(resolveAgent("claude", { HERMES_INTERACTIVE: "1" })).toEqual({
      agent: "claude",
      detected: false,
    });
  });

  it("falls back to claude with no env signal — detected, but the note stays silent for claude", () => {
    expect(resolveAgent(undefined, {})).toEqual({ agent: "claude", detected: true });
  });

  it("passes an explicit value through verbatim for the caller to typo-check", () => {
    expect(resolveAgent("codex", {})).toEqual({ agent: "codex", detected: false });
  });
});

describe("parseSetupAuthStatus", () => {
  it("uses the explicit tri-state status", () => {
    expect(parseSetupAuthStatus({ code: 0, stdout: '{"status":"valid"}' })).toBe("valid");
    expect(parseSetupAuthStatus({ code: 1, stdout: '{"status":"invalid"}' })).toBe("invalid");
    expect(parseSetupAuthStatus({ code: 2, stdout: '{"status":"unreachable"}' })).toBe(
      "unreachable",
    );
  });

  it("keeps authenticated:true compatibility and treats exit 2 as indeterminate", () => {
    expect(parseSetupAuthStatus({ code: 0, stdout: '{"authenticated":true}' })).toBe("valid");
    expect(parseSetupAuthStatus({ code: 2, stdout: "not-json" })).toBe("unreachable");
    expect(parseSetupAuthStatus({ code: 1, stdout: "" })).toBe("invalid");
  });
});

describe("registerSetupCommand", () => {
  it("registers --agent WITHOUT a default, so an omitted flag falls through to detection", () => {
    // Load-bearing: re-adding a default (e.g. `, "claude"`) would make opts.agent
    // never undefined, so resolveAgent never detects and a bare `prim setup`
    // silently routes every agent to claude — the exact regression this feature
    // exists to prevent. tsc can't catch it (the action's opts type is
    // hand-written), so pin the absence of a default here.
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === "setup");
    const agentOpt = setup?.options.find((o) => o.long === "--agent");
    expect(agentOpt).toBeDefined();
    expect(agentOpt?.defaultValue).toBeUndefined();
  });

  it("defaults --scope to user, so a bare `prim setup` installs for every repo", () => {
    const program = new Command();
    registerSetupCommand(program);
    const setup = program.commands.find((c) => c.name() === "setup");
    const scopeOpt = setup?.options.find((o) => o.long === "--scope");
    expect(scopeOpt?.defaultValue).toBe("user");
  });

  it("aborts an unreachable auth probe before login, preauth, or installation", async () => {
    const calls: string[][] = [];
    const exit = vi.fn();
    const program = new Command();
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        return {
          code: 2,
          stdout: JSON.stringify({
            authenticated: false,
            status: "unreachable",
            reason: "verification_unavailable",
          }),
        };
      },
      note: vi.fn(),
      exit,
    });

    await program.parseAsync(["setup"], { from: "user" });

    expect(calls).toEqual([["auth", "status", "--json"]]);
    expect(exit).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("requires a valid post-login verification before changing integrations", async () => {
    const calls: string[][] = [];
    const exit = vi.fn();
    const responses = [
      { code: 1, stdout: '{"status":"invalid"}' },
      { code: 0, stdout: "" },
      { code: 2, stdout: '{"status":"unreachable"}' },
    ];
    const program = new Command();
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        return responses.shift() ?? { code: 1, stdout: "" };
      },
      note: vi.fn(),
      exit,
    });

    await program.parseAsync(["setup"], { from: "user" });

    expect(calls).toEqual([
      ["auth", "status", "--json"],
      ["auth", "login"],
      ["auth", "status", "--json"],
    ]);
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("exits 1 when the single login attempt fails", async () => {
    const calls: string[][] = [];
    const exit = vi.fn();
    const program = new Command();
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        return args[0] === "auth" && args[1] === "status"
          ? { code: 1, stdout: '{"status":"invalid"}' }
          : { code: 1, stdout: "" };
      },
      note: vi.fn(),
      exit,
    });

    await program.parseAsync(["setup"], { from: "user" });

    expect(calls).toEqual([
      ["auth", "status", "--json"],
      ["auth", "login"],
    ]);
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("installs only after invalid credentials are logged in and verified", async () => {
    const calls: string[][] = [];
    const exit = vi.fn();
    let statusCalls = 0;
    const program = new Command();
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        if (args[0] === "auth" && args[1] === "status") {
          statusCalls += 1;
          return statusCalls === 1
            ? { code: 1, stdout: '{"status":"invalid"}' }
            : { code: 0, stdout: '{"status":"valid"}' };
        }
        return { code: 0, stdout: "" };
      },
      note: vi.fn(),
      exit,
    });

    await program.parseAsync(["setup", "--agent", "codex", "--scope", "project", "--no-daemon"], {
      from: "user",
    });

    expect(calls).toEqual([
      ["auth", "status", "--json"],
      ["auth", "login"],
      ["auth", "status", "--json"],
      ["codex", "install", "--scope", "project"],
      ["daemon", "stop"],
      ["hooks", "install"],
      ["skill", "install", "--agent", "codex"],
      ["enable"],
      ["welcome", "--agent", "codex"],
    ]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("forwards --yes to the enable step so the repository-binding prompt honors it", async () => {
    const calls: string[][] = [];
    const exit = vi.fn();
    const program = new Command();
    program.option("-y, --yes").option("--non-interactive");
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        return args[0] === "auth" && args[1] === "status"
          ? { code: 0, stdout: '{"status":"valid"}' }
          : { code: 0, stdout: "" };
      },
      note: vi.fn(),
      exit,
    });

    await program.parseAsync(
      ["--yes", "setup", "--agent", "codex", "--scope", "project", "--no-daemon"],
      { from: "user" },
    );

    expect(calls).toContainEqual(["enable", "--yes"]);
    expect(calls).not.toContainEqual(["enable"]);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("reports setup incomplete when GitHub repo connection is required", async () => {
    const calls: string[][] = [];
    const note = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        if (args[0] === "auth" && args[1] === "status") {
          return { code: 0, stdout: '{"status":"valid"}' };
        }
        if (args[0] === "codex" && args[1] === "status") {
          return { code: 0, stdout: '{"project":{"capture":false}}' };
        }
        if (args[0] === "skill" && args[1] === "status") {
          return { code: 0, stdout: '{"installed":false}' };
        }
        if (args[0] === "enable") {
          return { code: 1, stdout: '{"active":false,"bindingStatus":"unbound"}' };
        }
        if (args[0] === "doctor") {
          return { code: 0, stdout: '{"ok":true,"status":"warn"}' };
        }
        return { code: 0, stdout: "" };
      },
      note,
      exit,
    });

    await program.parseAsync(["setup", "--agent", "codex", "--scope", "project"], {
      from: "user",
    });

    expect(calls.filter((args) => args[0] === "enable")).toHaveLength(1);
    expect(calls.filter((args) => args[0] === "doctor")).toHaveLength(1);
    expect(note).toHaveBeenCalledWith(
      expect.stringMatching(/setup incomplete \(failed: enable\).*enable:failed.*health:ok/u),
    );
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("runs doctor after every project cleanup during user-scope migration", async () => {
    const calls: string[][] = [];
    const exit = vi.fn();
    const program = new Command();
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        if (args[0] === "auth" && args[1] === "status") {
          return { code: 0, stdout: '{"status":"valid"}' };
        }
        if (args[0] === "codex" && args[1] === "status") {
          return { code: 0, stdout: '{"project":{"capture":true}}' };
        }
        if (args[0] === "skill" && args[1] === "status") {
          return { code: 0, stdout: '{"installed":false}' };
        }
        return { code: 0, stdout: "" };
      },
      note: vi.fn(),
      exit,
    });

    await program.parseAsync(["setup", "--agent", "codex", "--scope", "user", "--migrate"], {
      from: "user",
    });

    const cleanup = calls.findIndex((args) => args[0] === "codex" && args[1] === "uninstall");
    const enable = calls.findIndex((args) => args[0] === "enable");
    const doctor = calls.findIndex((args) => args[0] === "doctor");
    const welcome = calls.findIndex((args) => args[0] === "welcome");
    expect(cleanup).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(cleanup);
    expect(doctor).toBeGreaterThan(cleanup);
    expect(doctor).toBeGreaterThan(enable);
    expect(welcome).toBeGreaterThan(doctor);
    expect(exit).toHaveBeenCalledWith(0);
  });

  describe("with a journal backlog queued before setup (PRI-68)", () => {
    // Exit codes mirror the real subcommands on such a machine: `daemon start`
    // succeeds once the daemon is live/authenticated/heartbeating, and doctor
    // passes only in setup's expected-backlog mode (standalone it exits 1 on
    // the missed 30s SLA). Their verdicts are pinned in daemon.start.spec.ts
    // and doctor.spec.ts; this pins setup's wiring of them.
    function backlogMachine(daemonStartCode: number, setupDoctorCode: number) {
      const calls: string[][] = [];
      const note = vi.fn();
      const exit = vi.fn();
      const program = new Command();
      registerSetupCommand(program, {
        run: (args) => {
          calls.push(args);
          if (args[0] === "auth" && args[1] === "status") {
            return { code: 0, stdout: '{"status":"valid"}' };
          }
          if (args[0] === "daemon" && args[1] === "start") {
            return { code: daemonStartCode, stdout: "" };
          }
          if (args[0] === "doctor") {
            return { code: args.includes("--expect-backlog") ? setupDoctorCode : 1, stdout: "" };
          }
          return { code: 0, stdout: "" };
        },
        note,
        exit,
      });
      return { calls, note, exit, program };
    }

    it("completes while the backlog drains in the background", async () => {
      const { calls, note, exit, program } = backlogMachine(0, 0);

      await program.parseAsync(["setup", "--agent", "codex", "--scope", "project"], {
        from: "user",
      });

      expect(calls).toContainEqual(["daemon", "start"]);
      expect(calls).toContainEqual(["doctor", "--expect-backlog"]);
      expect(note).toHaveBeenCalledWith(
        expect.stringMatching(/^setup complete — .*daemon:ok.*health:ok/u),
      );
      expect(exit).toHaveBeenCalledWith(0);
    });

    it("still fails when the daemon cannot become ready (re-auth, version skew, heartbeat)", async () => {
      // `daemon start` exits 2 for those causes, and doctor's daemon check
      // fails them even with --expect-backlog.
      const { note, exit, program } = backlogMachine(2, 1);

      await program.parseAsync(["setup", "--agent", "codex", "--scope", "project"], {
        from: "user",
      });

      expect(note).toHaveBeenCalledWith(
        expect.stringMatching(/setup incomplete \(failed: daemon, health\)/u),
      );
      expect(exit).toHaveBeenCalledWith(1);
    });
  });

  it("--no-daemon activates only after every project cleanup during user-scope migration", async () => {
    const calls: string[][] = [];
    const exit = vi.fn();
    const program = new Command();
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        if (args[0] === "auth" && args[1] === "status") {
          return { code: 0, stdout: '{"status":"valid"}' };
        }
        if (args[0] === "codex" && args[1] === "status") {
          return { code: 0, stdout: '{"project":{"capture":true}}' };
        }
        if (args[0] === "skill" && args[1] === "status") {
          return { code: 0, stdout: '{"installed":false}' };
        }
        return { code: 0, stdout: "" };
      },
      note: vi.fn(),
      exit,
    });

    await program.parseAsync(
      ["setup", "--agent", "codex", "--scope", "user", "--no-daemon", "--migrate"],
      { from: "user" },
    );

    const cleanup = calls.findIndex((args) => args[0] === "codex" && args[1] === "uninstall");
    const enable = calls.findIndex((args) => args[0] === "enable");
    expect(cleanup).toBeGreaterThan(-1);
    expect(enable).toBeGreaterThan(cleanup);
    expect(calls.some((args) => args[0] === "doctor")).toBe(false);
    expect(exit).toHaveBeenCalledWith(0);
  });
});

describe("preCommitRunsPrim", () => {
  it("recognizes the managed block and an older direct call, but not foreign hooks", () => {
    expect(preCommitRunsPrim("#!/bin/sh\n# >>> prim pre-commit hook >>>\n…\n")).toBe(true);
    expect(preCommitRunsPrim("#!/bin/sh\nprim-pre-commit\n")).toBe(true);
    expect(preCommitRunsPrim("#!/bin/sh\nnpx lint-staged\n")).toBe(false);
  });
});

describe("setup and git's global hooks", () => {
  function runSetup(argv: string[]) {
    const calls: string[][] = [];
    const note = vi.fn();
    const program = new Command();
    program.option("-y, --yes").option("--non-interactive");
    registerSetupCommand(program, {
      run: (args) => {
        calls.push(args);
        if (args[0] === "auth" && args[1] === "status") {
          return { code: 0, stdout: '{"status":"valid"}' };
        }
        return { code: 0, stdout: "{}" };
      },
      note,
      exit: vi.fn(),
    });
    return { calls, note, parse: () => program.parseAsync(argv, { from: "user" }) };
  }

  it("never touches git's global hooks by default, even with --yes", async () => {
    const { calls, note, parse } = runSetup(["--yes", "setup", "--agent", "codex", "--no-daemon"]);
    await parse();
    expect(calls.some((args) => args[0] === "hooks")).toBe(false);
    expect(calls.some((args) => args.includes("--global-hooks-path"))).toBe(false);
    expect(calls.some((args) => args[0] === "enable")).toBe(true);
    expect(note).toHaveBeenCalledWith(expect.stringContaining("--global-hooks-path"));
  });

  it("forwards --global-hooks-path as the only consent to a machine-wide change", async () => {
    const { calls, parse } = runSetup([
      "setup",
      "--agent",
      "codex",
      "--no-daemon",
      "--global-hooks-path",
    ]);
    await parse();
    expect(calls).toContainEqual(["hooks", "install", "--scope", "user", "--global-hooks-path"]);
  });
});

describe("projectHooksConflict", () => {
  const prim = "#!/bin/sh\n# >>> prim pre-commit hook >>>\n…\n";
  it("is a conflict only beside prim's global hooks", () => {
    expect(projectHooksConflict(true, prim)).toBe(true);
    expect(projectHooksConflict(false, prim)).toBe(false);
    expect(projectHooksConflict(true, "#!/bin/sh\nnpm test\n")).toBe(false);
    expect(projectHooksConflict(true, undefined)).toBe(false);
  });
});

describe("setup's global-hooks step status", () => {
  function setupWith(hooksCode: number, argv: string[]) {
    const note = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerSetupCommand(program, {
      run: (args) => {
        if (args[0] === "auth" && args[1] === "status") {
          return { code: 0, stdout: '{"status":"valid"}' };
        }
        if (args[0] === "hooks") return { code: hooksCode, stdout: "" };
        return { code: 0, stdout: "{}" };
      },
      note,
      exit,
    });
    return { note, exit, parse: () => program.parseAsync(argv, { from: "user" }) };
  }

  it("reports a declined global-hooks step as skipped, not ok", async () => {
    const { note, exit, parse } = setupWith(3, [
      "setup",
      "--agent",
      "codex",
      "--no-daemon",
      "--global-hooks-path",
    ]);
    await parse();
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/setup complete — .*hooks:skipped/u));
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("still fails setup when the global-hooks step fails outright", async () => {
    const { note, parse } = setupWith(1, [
      "setup",
      "--agent",
      "codex",
      "--no-daemon",
      "--global-hooks-path",
    ]);
    await parse();
    expect(note).toHaveBeenCalledWith(expect.stringMatching(/failed: hooks/u));
  });

  it("rejects --global-hooks-path outside user scope", async () => {
    const { exit, parse } = setupWith(0, [
      "setup",
      "--agent",
      "codex",
      "--scope",
      "project",
      "--global-hooks-path",
    ]);
    await parse();
    expect(exit).toHaveBeenCalledWith(2);
  });

  it("tells users who already have prim's global hooks that they stay active", async () => {
    vi.mocked(planGlobalHooks).mockReturnValueOnce({ action: "refresh" });
    const { note, parse } = setupWith(0, ["setup", "--agent", "codex", "--no-daemon"]);
    await parse();
    expect(note).toHaveBeenCalledWith(expect.stringContaining("prim's global hooks stay active"));
  });
});

describe("a repository that sets its own core.hooksPath", () => {
  function repoWithSharedGlobalHooks(): { root: string; cleanup: () => void } {
    const base = mkdtempSync(join(tmpdir(), "prim-setup-local-hooks-"));
    const root = join(base, "repo");
    const globalConfig = join(base, "gitconfig");
    writeFileSync(globalConfig, `[core]\n\thooksPath = ${join(base, "shared-hooks")}\n`);
    vi.stubEnv("GIT_CONFIG_GLOBAL", globalConfig);
    vi.stubEnv("GIT_CONFIG_SYSTEM", "/dev/null");
    vi.stubEnv("PRIM_CONFIG_DIR", join(base, "prim"));
    execFileSync("git", ["init", "-q", root]);
    return {
      root,
      cleanup: () => {
        vi.unstubAllEnvs();
        rmSync(base, { recursive: true, force: true });
      },
    };
  }

  it("is wired by `prim enable`, while one that runs the shared global dir is not", () => {
    const { root, cleanup } = repoWithSharedGlobalHooks();
    try {
      expect(enableWiresRepository(root)).toBe(false);
      execFileSync("git", ["config", "--local", "core.hooksPath", ".husky"], { cwd: root });
      expect(enableWiresRepository(root)).toBe(true);
      expect(enableWiresRepository(null)).toBeUndefined();
      execFileSync("git", ["config", "--local", "prim.gitHooks", "manual"], { cwd: root });
      expect(enableWiresRepository(root)).toBeUndefined();
      execFileSync("git", ["config", "--local", "--unset", "prim.gitHooks"], { cwd: root });
      const system = setupGitHooksNote(
        { action: "system_declined", system: "/etc/git/hooks" },
        true,
      );
      expect(system).toContain("`prim enable` wires it");
      expect(system).toContain("which prim never edits");
    } finally {
      cleanup();
    }
  });

  it("gets a setup note that asks for no consent", async () => {
    const { root, cleanup } = repoWithSharedGlobalHooks();
    try {
      execFileSync("git", ["config", "--local", "core.hooksPath", ".husky"], { cwd: root });
      vi.mocked(gitToplevel).mockReturnValue(root);
      vi.mocked(planGlobalHooks).mockReturnValue({ action: "add_to_dir", global: "/shared" });
      const note = vi.fn();
      const program = new Command();
      registerSetupCommand(program, {
        run: (args) =>
          args[0] === "auth" && args[1] === "status"
            ? { code: 0, stdout: '{"status":"valid"}' }
            : { code: 0, stdout: "{}" },
        note,
        exit: vi.fn(),
      });
      await program.parseAsync(["setup", "--agent", "codex", "--no-daemon"], { from: "user" });
      const hooksNote = note.mock.calls
        .map(([text]) => String(text))
        .find((text) => text.startsWith("git hooks ·"));
      expect(hooksNote).toContain("from inside it, so `prim enable` wires it");
      expect(hooksNote).not.toContain("cannot wire this repository");
    } finally {
      vi.mocked(gitToplevel).mockRestore();
      vi.mocked(planGlobalHooks).mockReturnValue({ action: "set_pointer" });
      cleanup();
    }
  });
});

describe("setupGitHooksNote", () => {
  it("warns users whose global hooks dir prim may not edit that enable needs consent", () => {
    const note = setupGitHooksNote({ action: "add_to_dir", global: "/home/u/.config/git/hooks" });
    expect(note).toContain("/home/u/.config/git/hooks");
    expect(note).toContain("--global-hooks-path, after asking the user");
  });

  it("never promises enable can wire through a system hooks path or in manual mode", () => {
    const system = setupGitHooksNote({ action: "system_declined", system: "/etc/git/hooks" });
    expect(system).toContain("cannot wire this repository");
    expect(system).toContain("--global-hooks-path --force");
    expect(system).not.toContain("untouched");
    expect(setupGitHooksNote({ action: "manual", global: "" })).toContain(
      "prim writes no hook files",
    );
  });

  it("does not claim git's global hooks are untouched when prim's are active", () => {
    expect(setupGitHooksNote({ action: "refresh" })).toContain("stay active");
    expect(setupGitHooksNote({ action: "set_pointer" })).toContain("untouched");
  });
});

describe("setup --migrate with prim's global hooks", () => {
  it("removes a project pre-commit that would double-fire beside them", async () => {
    const root = mkdtempSync(join(tmpdir(), "prim-migrate-"));
    try {
      mkdirSync(join(root, ".git", "hooks"), { recursive: true });
      writeFileSync(
        join(root, ".git", "hooks", "pre-commit"),
        "#!/bin/sh\n# >>> prim pre-commit hook >>>\n…\n# <<< prim pre-commit hook <<<\n",
      );
      vi.mocked(gitToplevel).mockReturnValue(root);
      vi.mocked(globalHooksPathIsPrims).mockReturnValue(true);
      const calls: string[][] = [];
      const program = new Command();
      registerSetupCommand(program, {
        run: (args) => {
          calls.push(args);
          if (args[0] === "auth" && args[1] === "status") {
            return { code: 0, stdout: '{"status":"valid"}' };
          }
          return { code: 0, stdout: "{}" };
        },
        note: vi.fn(),
        exit: vi.fn(),
      });
      await program.parseAsync(["setup", "--agent", "codex", "--no-daemon", "--migrate"], {
        from: "user",
      });
      expect(calls).toContainEqual(["hooks", "uninstall"]);

      // Without prim's global hooks the same pre-commit is how the repo is
      // wired, and migrate leaves it.
      calls.length = 0;
      vi.mocked(globalHooksPathIsPrims).mockReturnValue(false);
      await program.parseAsync(["setup", "--agent", "codex", "--no-daemon", "--migrate"], {
        from: "user",
      });
      expect(calls).not.toContainEqual(["hooks", "uninstall"]);
    } finally {
      vi.mocked(gitToplevel).mockRestore();
      vi.mocked(globalHooksPathIsPrims).mockReturnValue(false);
      rmSync(root, { recursive: true, force: true });
    }
  });
});
