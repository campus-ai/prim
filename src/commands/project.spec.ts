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

describe("project create stdout/stderr split (no --json)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("create (no --spec): prefix on stderr, bare id on stdout", async () => {
    const client = { post: vi.fn().mockResolvedValue({ _id: "proj-3" }) };
    vi.mocked(getClient).mockReturnValue(client as unknown as ReturnType<typeof getClient>);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerProjectCommands(program);
    await program.parseAsync(["project", "create", "-n", "p3"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["proj-3"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "Created project: proj-3",
    );
  });

  it("create --spec: both prefixes on stderr, bare project id on stdout", async () => {
    const client = { post: vi.fn().mockResolvedValue({ _id: "proj-4" }) };
    vi.mocked(getClient).mockReturnValue(client as unknown as ReturnType<typeof getClient>);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerProjectCommands(program);
    await program.parseAsync(["project", "create", "-n", "p4", "--spec", "ctx-77"], {
      from: "user",
    });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["proj-4"]);
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Created project: proj-4");
    expect(stderr).toContain("Linked spec: ctx-77");
  });
});
