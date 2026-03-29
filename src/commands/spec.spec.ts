import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerSpecCommands } from "./spec.js";

describe("registerSpecCommands", () => {
  it("registers the spec command group", () => {
    const program = new Command();
    registerSpecCommands(program);

    const spec = program.commands.find((c) => c.name() === "spec");
    expect(spec).toBeDefined();
  });

  it("registers all subcommands", () => {
    const program = new Command();
    registerSpecCommands(program);

    const spec = program.commands.find((c) => c.name() === "spec");
    const subcommands = spec?.commands.map((c) => c.name()) ?? [];

    expect(subcommands).toContain("list");
    expect(subcommands).toContain("get");
    expect(subcommands).toContain("update");
    expect(subcommands).toContain("sync");
    expect(subcommands).toContain("map");
    expect(subcommands).toContain("unmap");
    expect(subcommands).toContain("import-mappings");
  });
});
