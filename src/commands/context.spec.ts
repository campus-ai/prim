import { describe, it, expect } from "vitest";
import { Command } from "commander";
import { registerContextCommands } from "./context.js";

describe("registerContextCommands", () => {
  it("registers the context command group", () => {
    const program = new Command();
    registerContextCommands(program);

    const context = program.commands.find((c) => c.name() === "context");
    expect(context).toBeDefined();
  });

  it("registers all subcommands", () => {
    const program = new Command();
    registerContextCommands(program);

    const context = program.commands.find((c) => c.name() === "context");
    const subcommands = context?.commands.map((c) => c.name()) ?? [];

    expect(subcommands).toContain("list");
    expect(subcommands).toContain("get");
    expect(subcommands).toContain("create");
    expect(subcommands).toContain("update");
    expect(subcommands).toContain("delete");
    expect(subcommands).toContain("link");
    expect(subcommands).toContain("unlink");
  });
});
