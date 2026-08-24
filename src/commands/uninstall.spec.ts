import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  planUninstallSteps,
  registerUninstallCommand,
  uninstallStepSucceeded,
} from "./uninstall.js";

function successfulOutput(args: string[]): string {
  if (args[0] === "claude") {
    return JSON.stringify({ gate: false, capture: false, feedback: false, statusline: false });
  }
  if (args[0] === "codex" || args[0] === "hermes") {
    return JSON.stringify({ gate: false, capture: false });
  }
  return "";
}

describe("planUninstallSteps", () => {
  it("stops the daemon before removing current-project and user integrations", () => {
    expect(planUninstallSteps(true).map((step) => step.args)).toEqual([
      ["daemon", "stop"],
      ["claude", "uninstall", "--scope", "project"],
      ["codex", "uninstall", "--scope", "project"],
      ["hooks", "uninstall", "--scope", "project"],
      ["claude", "uninstall", "--scope", "user"],
      ["codex", "uninstall", "--scope", "user"],
      ["hermes", "uninstall"],
      ["hooks", "uninstall", "--scope", "user"],
    ]);
  });

  it("does not invent project targets outside a Git repository", () => {
    const steps = planUninstallSteps(false);
    expect(steps.map((step) => step.key)).toEqual([
      "daemon",
      "claude-user",
      "codex-user",
      "hermes-user",
      "hooks-user",
    ]);
    expect(steps.every((step) => !step.args.includes("project"))).toBe(true);
  });
});

describe("registerUninstallCommand", () => {
  it("requires agent uninstall postconditions before treating a step as successful", () => {
    const claude = planUninstallSteps(false).find((step) => step.key === "claude-user");
    expect(claude).toBeDefined();
    expect(
      uninstallStepSucceeded(claude as NonNullable<typeof claude>, {
        code: 0,
        stdout: JSON.stringify({ gate: false, capture: true, feedback: false, statusline: false }),
        stderr: "",
      }),
    ).toBe(false);
    expect(
      uninstallStepSucceeded(claude as NonNullable<typeof claude>, {
        code: 0,
        stdout: JSON.stringify({ gate: false, capture: false, feedback: false, statusline: false }),
        stderr: "",
      }),
    ).toBe(true);
  });

  it("removes runtime state only after every integration removal succeeds", async () => {
    const calls: string[][] = [];
    const removeRuntimes = vi.fn(async () => ({
      hookRuntimeChanged: true,
      daemonRuntimeChanged: true,
    }));
    const write = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerUninstallCommand(program, {
      inRepository: () => true,
      run: (args) => {
        calls.push(args);
        return { code: 0, stdout: successfulOutput(args), stderr: "" };
      },
      removeRuntimes,
      note: vi.fn(),
      write,
      exit,
    });

    await program.parseAsync(["uninstall"], { from: "user" });

    expect(calls).toEqual(planUninstallSteps(true).map((step) => step.args));
    expect(removeRuntimes).toHaveBeenCalledOnce();
    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      uninstalled: true,
      projectScopeChecked: true,
      runtime: { status: "removed", hookRuntimeChanged: true, daemonRuntimeChanged: true },
    });
    expect(exit).toHaveBeenCalledWith(0);
  });

  it("attempts every integration removal and retains runtimes after any failure", async () => {
    const calls: string[][] = [];
    const removeRuntimes = vi.fn();
    const write = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerUninstallCommand(program, {
      inRepository: () => false,
      run: (args) => {
        calls.push(args);
        return {
          code: args[0] === "hermes" ? 1 : 0,
          stdout: successfulOutput(args),
          stderr: args[0] === "hermes" ? "ambiguous hooks mapping" : "",
        };
      },
      removeRuntimes,
      note: vi.fn(),
      write,
      exit,
    });

    await program.parseAsync(["uninstall"], { from: "user" });

    expect(calls).toHaveLength(planUninstallSteps(false).length);
    expect(removeRuntimes).not.toHaveBeenCalled();
    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      uninstalled: false,
      runtime: {
        status: "retained",
        reason: "one or more integration removals failed",
      },
    });
    expect(exit).toHaveBeenCalledWith(1);
  });

  it("fails closed when runtime ownership is ambiguous", async () => {
    const write = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerUninstallCommand(program, {
      inRepository: () => false,
      run: (args) => ({ code: 0, stdout: successfulOutput(args), stderr: "" }),
      removeRuntimes: async () => {
        throw new Error("unrecognized hook release");
      },
      note: vi.fn(),
      write,
      exit,
    });

    await program.parseAsync(["uninstall"], { from: "user" });

    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      uninstalled: false,
      runtime: { status: "retained", reason: "unrecognized hook release" },
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
