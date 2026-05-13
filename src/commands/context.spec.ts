import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", () => ({
  getClient: vi.fn(),
}));

import { getClient } from "../client.js";
import { registerContextCommands } from "./context.js";

type MockClient = {
  get?: ReturnType<typeof vi.fn>;
  post?: ReturnType<typeof vi.fn>;
  patch?: ReturnType<typeof vi.fn>;
  delete?: ReturnType<typeof vi.fn>;
};

function withClient(client: MockClient) {
  vi.mocked(getClient).mockReturnValue(client as unknown as ReturnType<typeof getClient>);
}

function lastJson(logSpy: ReturnType<typeof vi.spyOn>): unknown {
  return JSON.parse(String(logSpy.mock.calls[0][0]));
}

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

describe("context subcommands --json", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("list emits the contexts array under --json", async () => {
    const payload = [{ _id: "c1", name: "alpha" }];
    withClient({ get: vi.fn().mockResolvedValue(payload) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "list", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual(payload);
  });

  it("get emits the raw ctx as JSON (default behavior, --json accepted)", async () => {
    const payload = { _id: "c1", name: "alpha", scope: "global" };
    withClient({ get: vi.fn().mockResolvedValue(payload) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "get", "c1", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual(payload);
  });

  it("create emits {_id} under --json", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ _id: "c2" }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "create", "-s", "global", "-n", "foo", "--json"], {
      from: "user",
    });

    expect(lastJson(logSpy)).toEqual({ _id: "c2" });
  });

  it("update emits {_id} under --json", async () => {
    withClient({ patch: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "update", "c3", "-n", "newname", "--json"], {
      from: "user",
    });

    expect(lastJson(logSpy)).toEqual({ _id: "c3" });
  });

  it("delete emits {_id} under --json", async () => {
    withClient({ delete: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "delete", "c4", "--json"], { from: "user" });

    expect(lastJson(logSpy)).toEqual({ _id: "c4" });
  });

  it("link emits {_id, project} under --json", async () => {
    withClient({ post: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "link", "c5", "--project", "p5", "--json"], {
      from: "user",
    });

    expect(lastJson(logSpy)).toEqual({ _id: "c5", project: "p5" });
  });

  it("unlink emits {_id, project} under --json", async () => {
    withClient({ post: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "unlink", "c6", "--project", "p6", "--json"], {
      from: "user",
    });

    expect(lastJson(logSpy)).toEqual({ _id: "c6", project: "p6" });
  });
});

describe("context subcommands stdout/stderr split (no --json)", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("create: prefix on stderr, bare id on stdout", async () => {
    withClient({ post: vi.fn().mockResolvedValue({ _id: "c2" }) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "create", "-s", "global", "-n", "foo"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["c2"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Created context: c2");
  });

  it("update: prefix on stderr, bare id on stdout", async () => {
    withClient({ patch: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "update", "c3", "-n", "renamed"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["c3"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Updated context: c3");
  });

  it("delete: prefix on stderr, bare id on stdout", async () => {
    withClient({ delete: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "delete", "c4"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["c4"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("Deleted context: c4");
  });

  it("link: prefix on stderr, bare context id on stdout", async () => {
    withClient({ post: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "link", "c5", "--project", "p5"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["c5"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "Linked context c5 to project p5",
    );
  });

  it("unlink: prefix on stderr, bare context id on stdout", async () => {
    withClient({ post: vi.fn().mockResolvedValue({}) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "unlink", "c6", "--project", "p6"], { from: "user" });

    expect(logSpy.mock.calls.map((c) => String(c[0]))).toEqual(["c6"]);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain(
      "Unlinked context c6 from project p6",
    );
  });

  it("list (empty): empty-state on stderr, nothing on stdout", async () => {
    withClient({ get: vi.fn().mockResolvedValue([]) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "list"], { from: "user" });

    expect(logSpy.mock.calls).toHaveLength(0);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("No contexts found.");
  });

  it("list (non-empty): rows on stdout, summary on stderr", async () => {
    const payload = [
      { _id: "c7", name: "alpha", scope: "global" },
      { _id: "c8", name: "beta", scope: "task" },
    ];
    withClient({ get: vi.fn().mockResolvedValue(payload) });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const program = new Command();
    registerContextCommands(program);
    await program.parseAsync(["context", "list"], { from: "user" });

    const stdout = logSpy.mock.calls.map((c) => String(c[0]));
    expect(stdout).toHaveLength(2);
    expect(stdout[0]).toMatch(/^c7\b/);
    expect(stdout[1]).toMatch(/^c8\b/);
    expect(errSpy.mock.calls.map((c) => String(c[0])).join("\n")).toContain("2 context(s)");
  });
});
