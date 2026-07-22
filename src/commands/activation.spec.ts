import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));
vi.mock("../client.js", () => ({ getClient: vi.fn() }));

import { execFileSync } from "node:child_process";
import { getClient } from "../client.js";
import { registerActivationCommands } from "./activation.js";

const mockedExecFileSync = vi.mocked(execFileSync);

// rev-parse --show-toplevel resolves the repo; config --local sets the flag.
const inRepo = (root: string | null): void => {
  mockedExecFileSync.mockImplementation(((_git: string, args: string[]): string => {
    if (args[0] === "rev-parse") {
      if (root === null) throw new Error("not a git repository");
      return `${root}\n`;
    }
    if (args.join(" ") === "config --get remote.origin.url") {
      return "git@github.com:campus-ai/primitive.git\n";
    }
    return "";
  }) as unknown as typeof execFileSync);
};

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerActivationCommands(program);
  return program;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getClient).mockReturnValue({
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ repoSyncId: "sync-1" }),
  });
});

describe("prim enable / disable", () => {
  it("registers both commands", () => {
    const program = new Command();
    registerActivationCommands(program);
    const names = program.commands.map((c) => c.name());
    expect(names).toContain("enable");
    expect(names).toContain("disable");
  });

  it("enable binds, persists the opaque id, then sets prim.active=true", async () => {
    inRepo("/repo");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await buildProgram().parseAsync(["enable"], { from: "user" });
    expect(vi.mocked(getClient)().post).toHaveBeenCalledWith("/api/cli/repositories/bind", {
      repositoryFullName: "campus-ai/primitive",
    });
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "prim.repoSyncId", "sync-1"],
      expect.anything(),
    );
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "prim.active", "true"],
      expect.anything(),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"active": true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"repoSyncId": "sync-1"'));
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("disable sets prim.active=false", async () => {
    inRepo("/repo");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await buildProgram().parseAsync(["disable"], { from: "user" });
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "prim.active", "false"],
      expect.anything(),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"active": false'));
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("exits 1 and never sets the flag outside a git repo", async () => {
    inRepo(null);
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(buildProgram().parseAsync(["enable"], { from: "user" })).rejects.toThrow(/exit 1/);
    // Only the rev-parse probe ran — no `config --local` write.
    const configWrites = mockedExecFileSync.mock.calls.filter(
      (c) => ((c[1] as string[] | undefined) ?? [])[0] === "config",
    );
    expect(configWrites).toHaveLength(0);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("never activates when binding fails", async () => {
    inRepo("/repo");
    vi.mocked(getClient)().post = vi.fn().mockRejectedValue(new Error("offline"));
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(buildProgram().parseAsync(["enable"], { from: "user" })).rejects.toThrow(/exit 1/);
    expect(
      mockedExecFileSync.mock.calls.some(
        (call) => (call[1] as string[]).join(" ") === "config --local prim.active true",
      ),
    ).toBe(false);
    exitSpy.mockRestore();
    errSpy.mockRestore();
  });
});
