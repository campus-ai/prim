import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));
vi.mock("../lib/post-commit-hook.js", () => ({
  ensureEffectivePostCommitHook: vi.fn(),
  ensureEffectivePostRewriteHook: vi.fn(),
}));
vi.mock("../lib/repository-binding.js", () => ({ bindRepository: vi.fn() }));
vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn(async () => null) }));
vi.mock("./hooks.js", () => ({ refreshOwnedGlobalHooks: vi.fn() }));
// Keep the real isNonInteractive (env/flag ladder), stub only the TTY prompt.
vi.mock("../lib/confirmation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/confirmation.js")>();
  return { ...actual, askConfirmation: vi.fn() };
});
vi.mock("./github.js", () => ({ runGithubConnect: vi.fn() }));

import { execFileSync } from "node:child_process";
import { daemonRequest } from "../daemon/client.js";
import { askConfirmation } from "../lib/confirmation.js";
import {
  ensureEffectivePostCommitHook,
  ensureEffectivePostRewriteHook,
} from "../lib/post-commit-hook.js";
import { bindRepository } from "../lib/repository-binding.js";
import { registerActivationCommands } from "./activation.js";
import { runGithubConnect } from "./github.js";
import { refreshOwnedGlobalHooks } from "./hooks.js";

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
  // Mirror the root program's interactive-gating globals so tests can drive the
  // connect prompt with `--yes` / `--non-interactive` (passed before the verb).
  program.option("-y, --yes").option("--non-interactive");
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
  vi.mocked(ensureEffectivePostRewriteHook).mockReturnValue({
    path: "/repo/.git/hooks/post-rewrite",
    changed: false,
    kind: "direct",
  });
  vi.mocked(bindRepository).mockResolvedValue({
    status: "connected",
    repoSyncId: "repoSync123",
    repositoryFullName: "campus-ai/primitive",
  });
  vi.mocked(askConfirmation).mockResolvedValue(false);
  vi.stubEnv("CI", "");
  vi.stubEnv("PRIM_NON_INTERACTIVE", "");
});

afterEach(() => {
  vi.unstubAllEnvs();
  process.exitCode = undefined;
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
    expect(refreshOwnedGlobalHooks).toHaveBeenCalledTimes(1);
    expect(ensureEffectivePostCommitHook).toHaveBeenCalledWith("/repo");
    expect(ensureEffectivePostRewriteHook).toHaveBeenCalledWith("/repo");
    expect(bindRepository).toHaveBeenCalledWith("/repo");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "prim.active", "true"],
      expect.anything(),
    );
    expect(daemonRequest).toHaveBeenCalledWith("statusline_invalidate", {}, { timeoutMs: 250 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"active": true'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"repoSyncId": "repoSync123"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"bindingStatus": "connected"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"postCommitHook"'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"postRewriteHook"'));
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("refreshes both owned global hooks before checking effective coverage", async () => {
    inRepo("/repo");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    expect(vi.mocked(refreshOwnedGlobalHooks).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ensureEffectivePostCommitHook).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(ensureEffectivePostCommitHook).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(ensureEffectivePostRewriteHook).mock.invocationCallOrder[0],
    );
    expect(bindRepository).toHaveBeenCalledWith("/repo");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("requires GitHub repo connection before activating an unconnected repository", async () => {
    inRepo("/repo");
    vi.mocked(bindRepository).mockResolvedValue({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    expect(
      mockedExecFileSync.mock.calls.some(
        (call) => (call[1] as string[]).join(" ") === "config --local prim.active true",
      ),
    ).toBe(false);
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(output).toMatchObject({
      active: false,
      repo: "/repo",
      bindingStatus: "unbound",
      repositoryFullName: "campus-ai/primitive",
      postCommitHook: "/repo/.git/hooks/post-commit",
    });
    expect(output).not.toHaveProperty("repoSyncId");
    const message = errSpy.mock.calls.map(([message]) => String(message)).join("");
    expect(message).toContain("GitHub repo connection is required before using Primitive");
    expect(message).toContain("repository-specific file attribution");
    expect(message).toContain("Conflict Gate verification");
    expect(message).toContain("commit correlation");
    expect(message).toContain("prim github connect");
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("repairs coverage and resolves binding before activating", async () => {
    inRepo("/repo");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    const activeWriteIndex = mockedExecFileSync.mock.calls.findIndex(
      (call) => (call[1] as string[]).join(" ") === "config --local prim.active true",
    );
    expect(activeWriteIndex).toBeGreaterThanOrEqual(0);
    expect(vi.mocked(ensureEffectivePostCommitHook).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(bindRepository).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(bindRepository).mock.invocationCallOrder[0]).toBeLessThan(
      mockedExecFileSync.mock.invocationCallOrder[activeWriteIndex],
    );
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
    expect(ensureEffectivePostRewriteHook).not.toHaveBeenCalled();
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
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "failed to enable prim during post-commit hook coverage: malformed Prim hook markers",
      ),
    );
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("enables with an explicit degradation when only post-rewrite coverage fails", async () => {
    inRepo("/repo");
    vi.mocked(ensureEffectivePostRewriteHook).mockImplementation(() => {
      throw new Error("Husky post-rewrite dispatcher is missing");
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    expect(bindRepository).toHaveBeenCalledWith("/repo");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "prim.active", "true"],
      expect.anything(),
    );
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("post-rewrite hook coverage is degraded"),
    );
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"active": true'));
    expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining('"postRewriteHook"'));
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("never activates when GitHub repo connection verification fails", async () => {
    inRepo("/repo");
    vi.mocked(bindRepository).mockRejectedValue(new Error("Authentication expired"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
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
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "failed to enable prim during GitHub repo connection: Authentication expired",
      ),
    );
    expect(logSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("surfaces local activation write failures after a successful binding", async () => {
    mockedExecFileSync.mockImplementation(((_git: string, args: string[]): string => {
      if (args[0] === "rev-parse") return "/repo\n";
      if (args.join(" ") === "config --local prim.active true") {
        throw new Error("could not lock .git/config");
      }
      return "";
    }) as unknown as typeof execFileSync);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });

    await expect(buildProgram().parseAsync(["enable"], { from: "user" })).rejects.toThrow(/exit 1/);

    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "failed to enable prim during local activation: could not lock .git/config",
      ),
    );
    expect(logSpy).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("prompts to connect an unbound repo and folds a successful connection into the result", async () => {
    inRepo("/repo");
    vi.mocked(bindRepository).mockResolvedValue({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    vi.mocked(askConfirmation).mockResolvedValue(true);
    vi.mocked(runGithubConnect).mockResolvedValue({
      kind: "connected",
      binding: {
        status: "connected",
        repoSyncId: "repoSyncNew",
        repositoryFullName: "campus-ai/primitive",
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    expect(askConfirmation).toHaveBeenCalledWith(
      expect.stringContaining("GitHub repo connection is required"),
      process.stderr,
    );
    expect(runGithubConnect).toHaveBeenCalledWith(undefined, { root: "/repo", browser: true });
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(output).toMatchObject({ bindingStatus: "connected", repoSyncId: "repoSyncNew" });
    const stderr = errSpy.mock.calls.map(([m]) => String(m)).join("");
    expect(stderr).toContain("GitHub repo connection complete for campus-ai/primitive");
    expect(stderr).not.toContain("organization owner or administrator");
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("auto-launches the connect flow under --yes without prompting", async () => {
    inRepo("/repo");
    vi.mocked(bindRepository).mockResolvedValue({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    vi.mocked(runGithubConnect).mockResolvedValue({
      kind: "connected",
      binding: {
        status: "connected",
        repoSyncId: "repoSyncNew",
        repositoryFullName: "campus-ai/primitive",
      },
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["--yes", "enable"], { from: "user" });

    expect(askConfirmation).not.toHaveBeenCalled();
    expect(runGithubConnect).toHaveBeenCalledWith(undefined, { root: "/repo", browser: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("does not activate when the required GitHub connection prompt is declined", async () => {
    inRepo("/repo");
    vi.mocked(bindRepository).mockResolvedValue({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    vi.mocked(askConfirmation).mockResolvedValue(false);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    expect(runGithubConnect).not.toHaveBeenCalled();
    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(output).toMatchObject({ active: false, bindingStatus: "unbound" });
    const stderr = errSpy.mock.calls.map(([m]) => String(m)).join("");
    expect(stderr).toContain("prim github connect");
    expect(stderr).toContain("repository-specific file attribution");
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("does not activate an unconnected repository when non-interactive", async () => {
    inRepo("/repo");
    vi.mocked(bindRepository).mockResolvedValue({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["--non-interactive", "enable"], { from: "user" });

    expect(askConfirmation).not.toHaveBeenCalled();
    expect(runGithubConnect).not.toHaveBeenCalled();
    const stderr = errSpy.mock.calls.map(([m]) => String(m)).join("");
    expect(stderr).toContain("prim github connect");
    expect(stderr).toContain("GitHub repo connection is required");
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("does not activate when an accepted GitHub connection does not complete", async () => {
    inRepo("/repo");
    vi.mocked(bindRepository).mockResolvedValue({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    vi.mocked(askConfirmation).mockResolvedValue(true);
    vi.mocked(runGithubConnect).mockResolvedValue({
      kind: "error",
      error: new Error("network down"),
    });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    const output = JSON.parse(String(logSpy.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(output).toMatchObject({ active: false, bindingStatus: "unbound" });
    const stderr = errSpy.mock.calls.map(([m]) => String(m)).join("");
    expect(stderr).toContain("connect could not complete: network down");
    expect(stderr).toContain("prim github connect");
    expect(stderr).toContain("GitHub repo connection is required");
    expect(process.exitCode).toBe(1);
    logSpy.mockRestore();
    errSpy.mockRestore();
  });
});
