import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));
vi.mock("../lib/post-commit-hook.js", () => ({
  ensureEffectivePostCommitHook: vi.fn(),
}));
vi.mock("../lib/repository-binding.js", () => ({ bindRepository: vi.fn() }));
vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn(async () => null) }));

import { execFileSync } from "node:child_process";
import { daemonRequest } from "../daemon/client.js";
import { ensureEffectivePostCommitHook } from "../lib/post-commit-hook.js";
import { bindRepository } from "../lib/repository-binding.js";
import { registerActivationCommands } from "./activation.js";

const mockedExecFileSync = vi.mocked(execFileSync);

// rev-parse --show-toplevel resolves the repo; config --local sets the flag.
const inRepo = (root: string | null): void => {
  mockedExecFileSync.mockImplementation(((_git: string, args: string[]): string => {
    if (args[0] === "rev-parse") {
      if (root === null) throw new Error("not a git repository");
      return `${root}\n`;
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
  vi.mocked(ensureEffectivePostCommitHook).mockReturnValue({
    path: "/repo/.git/hooks/post-commit",
    changed: false,
    kind: "direct",
  });
  vi.mocked(bindRepository).mockResolvedValue({
    repoSyncId: "repoSync123",
    repositoryFullName: "campus-ai/primitive",
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

  it("enable repairs coverage, binds, sets prim.active=true, and prints the result", async () => {
    inRepo("/repo");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await buildProgram().parseAsync(["enable"], { from: "user" });
    expect(ensureEffectivePostCommitHook).toHaveBeenCalledWith("/repo");
    expect(bindRepository).toHaveBeenCalledWith("/repo");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "prim.active", "true"],
      expect.anything(),
    );
    expect(daemonRequest).toHaveBeenCalledWith("statusline_invalidate", {}, { timeoutMs: 250 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"active": true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"repoSyncId": "repoSync123"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"postCommitHook"'));
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
    expect(daemonRequest).toHaveBeenCalledWith("statusline_invalidate", {}, { timeoutMs: 250 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"active": false'));
    expect(ensureEffectivePostCommitHook).not.toHaveBeenCalled();
    expect(bindRepository).not.toHaveBeenCalled();
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

  it("never activates or reports success when effective hook repair fails", async () => {
    inRepo("/repo");
    vi.mocked(ensureEffectivePostCommitHook).mockImplementation(() => {
      throw new Error("malformed Prim hook markers");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(buildProgram().parseAsync(["enable"], { from: "user" })).rejects.toThrow(/exit 1/);
    expect(bindRepository).not.toHaveBeenCalled();
    expect(
      mockedExecFileSync.mock.calls.some(
        (call) => (call[1] as string[]).join(" ") === "config --local prim.active true",
      ),
    ).toBe(false);
    expect(logSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });
});
