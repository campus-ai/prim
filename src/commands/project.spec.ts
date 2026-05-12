import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "../client.js";
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

describe("project create --json", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits {_id} when --json is set without --spec", async () => {
    const client = { post: vi.fn().mockResolvedValue({ _id: "proj-1" }) };
    vi.mocked(getClient).mockReturnValue(client as unknown as ReturnType<typeof getClient>);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerProjectCommands(program);
    await program.parseAsync(["project", "create", "-n", "p1", "--json"], { from: "user" });

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ _id: "proj-1" });
  });

  it("emits {_id, spec} when --json and --spec are set", async () => {
    const client = { post: vi.fn().mockResolvedValue({ _id: "proj-2" }) };
    vi.mocked(getClient).mockReturnValue(client as unknown as ReturnType<typeof getClient>);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerProjectCommands(program);
    await program.parseAsync(["project", "create", "-n", "p2", "--spec", "ctx-9", "--json"], {
      from: "user",
    });

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({ _id: "proj-2", spec: "ctx-9" });
  });
});
