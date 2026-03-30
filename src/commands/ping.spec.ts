import { Command } from "commander";
import { describe, expect, it } from "vitest";
import { registerPingCommand } from "./ping.js";

describe("registerPingCommand", () => {
  it("registers the ping command", () => {
    const program = new Command();
    registerPingCommand(program);

    const ping = program.commands.find((c) => c.name() === "ping");
    expect(ping).toBeDefined();
  });
});
