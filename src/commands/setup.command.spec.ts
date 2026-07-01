/**
 * `prim setup` — the pure, testable seams the command action depends on: the
 * step plan (ordering, agent branch, daemon toggle, scope passthrough), agent
 * detection and resolution, and the option wiring. The action callback itself
 * spawns real subcommands and drives the browser login, so it is not unit-tested
 * here — by repo convention the agent and step choices it makes are extracted
 * into pure functions (detectAgent / resolveAgent / planSetupSteps) and pinned
 * below; only thin glue (the typo-check, the inferred-agent note) rides along.
 */

import { Command } from "commander";
import { describe, expect, it } from "vitest";
import {
  detectAgent,
  planCleanupUninstalls,
  planSetupSteps,
  registerSetupCommand,
  resolveAgent,
} from "./setup.js";

const keys = (opts: Parameters<typeof planSetupSteps>[0]) => planSetupSteps(opts).map((s) => s.key);

describe("planSetupSteps", () => {
  it("claude, with daemon: session → daemon → hooks → skill, in order", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: true, scope: "project" });
    expect(steps.map((s) => s.key)).toEqual(["session", "daemon", "hooks", "skill"]);
    expect(steps[0].args).toEqual(["claude", "install"]);
    // daemon is the only tolerated-skip step; the rest are required.
    expect(steps.filter((s) => !s.required).map((s) => s.key)).toEqual(["daemon"]);
  });

  it("codex: session step targets the codex integration; skill targets AGENTS.md via --agent", () => {
    const steps = planSetupSteps({ agent: "codex", daemon: true, scope: "project" });
    expect(steps[0].args).toEqual(["codex", "install"]);
    expect(steps[0].label).toMatch(/codex/i);
    expect(steps.find((s) => s.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--agent",
      "codex",
    ]);
  });

  it("--no-daemon: drops the daemon step, keeps the required ones", () => {
    expect(keys({ agent: "claude", daemon: false, scope: "project" })).toEqual([
      "session",
      "hooks",
      "skill",
    ]);
  });

  it("user scope: forwards --scope user to session, hooks, AND skill", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: false, scope: "user" });
    expect(steps[0].args).toEqual(["claude", "install", "--scope", "user"]);
    // The whole point of user scope: git hooks and the rules file go global too.
    expect(steps.find((s) => s.key === "hooks")?.args).toEqual([
      "hooks",
      "install",
      "--scope",
      "user",
    ]);
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
    expect(steps[0].args).toEqual(["claude", "install"]);
    expect(steps.find((s) => s.key === "hooks")?.args).toEqual(["hooks", "install"]);
    expect(steps.find((s) => s.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--agent",
      "claude",
    ]);
  });

  it("hermes: session stays global-only (no scope flag), but hooks + skill still take --scope user", () => {
    const steps = planSetupSteps({ agent: "hermes", daemon: false, scope: "user" });
    expect(steps[0].args).toEqual(["hermes", "install"]);
    expect(steps[0].label).toMatch(/hermes/i);
    expect(steps.find((s) => s.key === "hooks")?.args).toEqual([
      "hooks",
      "install",
      "--scope",
      "user",
    ]);
    expect(steps.find((s) => s.key === "skill")?.args).toEqual([
      "skill",
      "install",
      "--agent",
      "hermes",
      "--scope",
      "user",
    ]);
  });

  it("user scope: appends an 'enable' step to activate this repo (tolerated skip)", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: false, scope: "user" });
    const enable = steps.find((s) => s.key === "enable");
    expect(enable?.args).toEqual(["enable"]);
    expect(enable?.required).toBe(false); // setup may run outside a git repo
  });

  it("project scope: no 'enable' step — a project install is itself the activation", () => {
    const steps = planSetupSteps({ agent: "claude", daemon: true, scope: "project" });
    expect(steps.find((s) => s.key === "enable")).toBeUndefined();
  });
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
});
