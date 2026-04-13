import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerTaskCommands } from "./task.js";

describe("registerTaskCommands", () => {
  it("registers the task command group", () => {
    const program = new Command();
    registerTaskCommands(program);

    const task = program.commands.find((c) => c.name() === "task");
    expect(task).toBeDefined();
  });

  it("registers the create subcommand", () => {
    const program = new Command();
    registerTaskCommands(program);

    const task = program.commands.find((c) => c.name() === "task");
    const subcommands = task?.commands.map((c) => c.name()) ?? [];
    expect(subcommands).toContain("create");
  });
});
