import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerProjectCommands } from "./project.js";

describe("registerProjectCommands", () => {
  it("registers the project command group", () => {
    const program = new Command();
    registerProjectCommands(program);

    const project = program.commands.find((c) => c.name() === "project");
    expect(project).toBeDefined();
  });

  it("registers the create subcommand", () => {
    const program = new Command();
    registerProjectCommands(program);

    const project = program.commands.find((c) => c.name() === "project");
    const subcommands = project?.commands.map((c) => c.name()) ?? [];
    expect(subcommands).toContain("create");
  });
});
