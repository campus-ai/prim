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
    expect(subcommands).toContain("create");
    expect(subcommands).toContain("update");
    expect(subcommands).toContain("sync");
    expect(subcommands).toContain("review");
    expect(subcommands).toContain("status");
    expect(subcommands).toContain("drift");
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

  it("create emits {_id} under --json", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ _id: "s-new" }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "create", "-s", "global", "-n", "fresh", "--json"], {
      from: "user",
    });

    expect(lastJson(logSpy)).toEqual({ _id: "s-new" });
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

describe("spec subcommands stdout/stderr split (no --json)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("create: prefix on stderr, bare id on stdout", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ _id: "s-new" }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "create", "-s", "global", "-n", "fresh"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["s-new"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Created spec: s-new");
  });

  it("update: prefix on stderr, bare id on stdout", async () => {
    withClient({ patch: vi.fn().mockResolvedValue({}), post: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "update", "s4", "-n", "renamed"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["s4"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Updated spec: s4");
  });

  it("sync: primary + root prefix on stderr, only spec id on stdout", async () => {
    withClient({
      get: vi.fn().mockResolvedValue({ isSpecDocument: true, specRootTaskId: "root-1" }),
      post: vi.fn().mockResolvedValue({}),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "sync", "s5"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["s5"]);
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Triggered sync for spec: s5");
    expect(stderr).toContain("Root project: root-1");
  });

  it("map: header + patterns on stderr, only spec id on stdout", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ filePatterns: ["src/a/**", "src/b/**"] }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "map", "s6", "-p", "src/a/**", "src/b/**"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["s6"]);
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Mapped patterns to spec s6:");
    expect(stderr).toContain("src/a/**");
    expect(stderr).toContain("src/b/**");
  });

  it("unmap (cleared branch): prefix on stderr, bare id on stdout", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ filePatterns: [] }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "unmap", "s7"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["s7"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "Cleared all file patterns from spec s7",
    );
  });

  it("unmap (updated branch): header + remaining patterns on stderr, bare id on stdout", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ filePatterns: ["src/c/**"] }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "unmap", "s7b", "-p", "src/b/**"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["s7b"]);
    const stderr = errSpy.mock.calls.map((c) => String(c[0])).join("\n");
    expect(stderr).toContain("Updated patterns for spec s7b:");
    expect(stderr).toContain("src/c/**");
  });

  it("auto-map: prefix on stderr, bare id on stdout", async () => {
    withClient({ post: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "auto-map", "s8"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["s8"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "Auto-mapping triggered for spec: s8",
    );
  });

  it("list (empty, no project-id): empty-state on stderr, nothing on stdout", async () => {
    withClient({ get: vi.fn().mockResolvedValue([]) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "list"], { from: "user" });

    expect(logSpy.mock.calls).toHaveLength(0);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "No spec documents found.",
    );
  });

  it("list (non-empty): rows on stdout, summary on stderr", async () => {
    const payload = [
      { _id: "s9", name: "spec-a", scope: "task", specReviewStatus: "approved" },
      { _id: "s10", name: "spec-b", scope: "global", specReviewStatus: "draft" },
    ];
    withClient({ get: vi.fn().mockResolvedValue(payload) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "list"], { from: "user" });

    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toMatch(/^s9\b/);
    expect(stdout[1]).toMatch(/^s10\b/);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("2 spec(s)");
  });

  it("list --project-id (empty): empty-state on stderr, nothing on stdout", async () => {
    withClient({ get: vi.fn().mockResolvedValue([]) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerSpecCommands(program);
    await program.parseAsync(["spec", "list", "-t", "proj-empty"], { from: "user" });

    expect(logSpy.mock.calls).toHaveLength(0);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "No spec document found for this project.",
    );
  });
});
