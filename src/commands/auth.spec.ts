import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerAuthCommands } from "./auth.js";

describe("registerAuthCommands", () => {
  it("registers the auth command group", () => {
    const program = new Command();
    registerAuthCommands(program);

    const auth = program.commands.find((c) => c.name() === "auth");
    expect(auth).toBeDefined();
  });

  it("registers login, set-token, and clear subcommands", () => {
    const program = new Command();
    registerAuthCommands(program);

    const auth = program.commands.find((c) => c.name() === "auth");
    const subcommands = auth?.commands.map((c) => c.name()) ?? [];

    expect(subcommands).toContain("login");
    expect(subcommands).toContain("set-token");
    expect(subcommands).toContain("clear");
  });
});
