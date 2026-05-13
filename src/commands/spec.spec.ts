import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "../client.js";
import { registerSpecCommands } from "./spec.js";

type MockClient = {
  get?: ReturnType<typeof vi.fn>;
  post?: ReturnType<typeof vi.fn>;
  patch?: ReturnType<typeof vi.fn>;
};

function withClient(client: MockClient) {
  vi.mocked(getClient).mockReturnValue(client as unknown as ReturnType<typeof getClient>);
}

function lastJson(logSpy: ReturnType<typeof vi.spyOn>): unknown {
  return JSON.parse(String(logSpy.mock.calls[0][0]));
}

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
    expect(subcommands).toContain("auto-map");
  });
});

describe("spec subcommands --json", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list emits the array under --json (no project-id)", async () => {
    const payload = [{ _id: "s1", name: "spec-a" }];
    withClient({ get: vi.fn().mockResolvedValue(payload) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "list", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual(payload);
  });

  it("list --project-id emits the single spec object under --json", async () => {
    const spec = { _id: "s2", name: "scoped" };
    withClient({ get: vi.fn().mockResolvedValue([spec]) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "list", "-t", "proj-1", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual(spec);
  });

  it("list --project-id emits null when no specs exist under --json", async () => {
    withClient({ get: vi.fn().mockResolvedValue([]) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "list", "-t", "proj-empty", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toBeNull();
  });

  it("get emits the full ctx under --json (overrides --text-only)", async () => {
    const ctx = { _id: "s3", name: "spec-c", text: "body" };
    withClient({ get: vi.fn().mockResolvedValue(ctx) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "get", "s3", "--text-only", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual(ctx);
  });

  it("update emits {_id} under --json", async () => {
    withClient({ patch: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "update", "s4", "-n", "renamed", "--json"], {
      from: "user",
    });

    expect(lastJson(logSpy)).toEqual({ _id: "s4" });
  });

  it("sync emits {_id, specRootTaskId} under --json when root project is present", async () => {
    withClient({
      get: vi.fn().mockResolvedValue({ isSpecDocument: true, specRootTaskId: "root-1" }),
      post: vi.fn().mockResolvedValue({}),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "sync", "s5", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual({ _id: "s5", specRootTaskId: "root-1" });
  });

  it("map emits {_id, filePatterns} under --json", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ filePatterns: ["src/a/**"] }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "map", "s6", "-p", "src/a/**", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual({ _id: "s6", filePatterns: ["src/a/**"] });
  });

  it("unmap emits {_id, filePatterns} under --json", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ filePatterns: [] }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "unmap", "s7", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual({ _id: "s7", filePatterns: [] });
  });

  it("auto-map emits {_id} under --json", async () => {
    withClient({ post: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "auto-map", "s8", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual({ _id: "s8" });
  });
});
