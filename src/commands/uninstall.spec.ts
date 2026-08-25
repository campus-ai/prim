import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import {
  planUninstallSteps,
  registerUninstallCommand,
  removeOwnedRuntimes,
  uninstallStepSucceeded,
} from "./uninstall.js";

function successfulOutput(args: string[]): string {
  if (args[0] === "daemon") {
    return JSON.stringify({ stopped: false, wasRunning: false, absent: true, verified: true });
  }
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

  it.each([
    ["EPERM stop failure", { stopped: false, pid: 42, verified: false }],
    ["active socket without a pidfile", { stopped: false, wasRunning: true, verified: false }],
  ])("rejects an ambiguous daemon stop after %s", (_name, stdout) => {
    const daemon = planUninstallSteps(false).find((step) => step.key === "daemon");
    expect(daemon).toBeDefined();
    expect(
      uninstallStepSucceeded(daemon as NonNullable<typeof daemon>, {
        code: 0,
        stdout: JSON.stringify(stdout),
        stderr: "",
      }),
    ).toBe(false);
  });

  it("removes runtime state only after every integration removal succeeds", async () => {
    const calls: string[][] = [];
    const removeRuntimes = vi.fn(async () => ({
      status: "removed" as const,
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

  it.each([
    ["EPERM", { stopped: false, pid: 42, verified: false }],
    ["active socket without a pidfile", { stopped: false, wasRunning: true, verified: false }],
  ])("retains both runtimes when daemon stop reports %s", async (_name, daemon) => {
    const removeRuntimes = vi.fn();
    const write = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerUninstallCommand(program, {
      inRepository: () => false,
      run: (args) => ({
        code: 0,
        stdout: args[0] === "daemon" ? JSON.stringify(daemon) : successfulOutput(args),
        stderr: "",
      }),
      removeRuntimes,
      note: vi.fn(),
      write,
      exit,
    });

    await program.parseAsync(["uninstall"], { from: "user" });

    expect(removeRuntimes).not.toHaveBeenCalled();
    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      uninstalled: false,
      runtime: { status: "retained", reason: "one or more integration removals failed" },
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
      removeRuntimes: async () => ({ status: "retained", reason: "unrecognized hook release" }),
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

  it("reports the exact partial runtime state when the second remover races", async () => {
    const write = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerUninstallCommand(program, {
      inRepository: () => false,
      run: (args) => ({ code: 0, stdout: successfulOutput(args), stderr: "" }),
      removeRuntimes: () =>
        removeOwnedRuntimes({
          assertHookRuntime: () => {},
          assertDaemonRuntime: () => {},
          removeHookRuntime: () => ({ changed: true }),
          removeDaemonRuntime: async () => {
            throw new Error("daemon restart race");
          },
        }),
      note: vi.fn(),
      write,
      exit,
    });

    await program.parseAsync(["uninstall"], { from: "user" });

    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      uninstalled: false,
      runtime: {
        status: "partial",
        hookRuntime: "removed",
        daemonRuntime: "unknown",
        reason: "daemon restart race",
      },
    });
    expect(exit).toHaveBeenCalledWith(1);
  });
});
