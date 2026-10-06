import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));
vi.mock("../lib/git-hooks.js", () => ({
  MANAGED_GIT_HOOK_NAMES: ["pre-commit", "post-commit", "post-rewrite"],
  ensureEffectiveGitHook: vi.fn(),
}));
vi.mock("../lib/repository-binding.js", () => ({ bindRepository: vi.fn() }));
vi.mock("../lib/commit-heartbeat.js", () => ({ recordHooksWired: vi.fn() }));
vi.mock("../lib/collect-scope.js", () => ({ fetchAndCacheCollectScope: vi.fn() }));
vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn(async () => null) }));
vi.mock("./hooks.js", () => ({ refreshOwnedGlobalHooks: vi.fn(), stageGitHookRuntime: vi.fn() }));
// Keep the real isNonInteractive (env/flag ladder), stub only the TTY prompt.
vi.mock("../lib/confirmation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/confirmation.js")>();
  return { ...actual, askConfirmation: vi.fn() };
});
vi.mock("./github.js", () => ({ runGithubConnect: vi.fn() }));

import { execFileSync } from "node:child_process";
import { daemonRequest } from "../daemon/client.js";
import { fetchAndCacheCollectScope } from "../lib/collect-scope.js";
import { recordHooksWired } from "../lib/commit-heartbeat.js";
import { askConfirmation } from "../lib/confirmation.js";
import { type EnsureHookResult, ensureEffectiveGitHook } from "../lib/git-hooks.js";
import { bindRepository } from "../lib/repository-binding.js";
import { registerActivationCommands } from "./activation.js";
import { runGithubConnect } from "./github.js";
import { refreshOwnedGlobalHooks, stageGitHookRuntime } from "./hooks.js";

const EXPLICIT = { context: "explicit" };

function hookResult(
  hookName: EnsureHookResult["hookName"],
  outcome: EnsureHookResult["outcome"] = "unchanged",
): EnsureHookResult {
  return {
    hookName,
    path: `/repo/.git/hooks/${hookName}`,
    changed: false,
    kind: "direct",
    outcome,
  };
}

function failHook(failing: EnsureHookResult["hookName"], message: string): void {
  vi.mocked(ensureEffectiveGitHook).mockImplementation((hookName) => {
    if (hookName === failing) throw new Error(message);
    return hookResult(hookName);
  });
}

function hookCallOrder(hookName: string): number {
  const index = vi
    .mocked(ensureEffectiveGitHook)
    .mock.calls.findIndex(([name]) => name === hookName);
  return vi.mocked(ensureEffectiveGitHook).mock.invocationCallOrder[index] ?? Number.NaN;
}

const mockedExecFileSync = vi.mocked(execFileSync);

// rev-parse --show-toplevel resolves the repo; config --local sets the flag.
const inRepo = (root: string | null, options: { active?: boolean } = {}): void => {
  mockedExecFileSync.mockImplementation(((_git: string, args: string[]): string => {
    if (args[0] === "rev-parse") {
      if (root === null) throw new Error("not a git repository");
      return `${root}\n`;
    }
    if (args.join(" ") === "config --get prim.active") return options.active ? "true\n" : "";
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
  vi.mocked(ensureEffectiveGitHook).mockImplementation((hookName) => hookResult(hookName));
  vi.mocked(bindRepository).mockResolvedValue({
    status: "connected",
    repoSyncId: "repoSync123",
    repositoryFullName: "campus-ai/primitive",
  });
  vi.mocked(fetchAndCacheCollectScope).mockResolvedValue({ kind: "unfetched" });
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
    expect(stageGitHookRuntime).toHaveBeenCalledTimes(1);
    expect(refreshOwnedGlobalHooks).toHaveBeenCalledTimes(1);
    for (const hookName of ["pre-commit", "post-commit", "post-rewrite"]) {
      expect(ensureEffectiveGitHook).toHaveBeenCalledWith(hookName, "/repo", EXPLICIT);
    }
    expect(bindRepository).toHaveBeenCalledWith("/repo");
    expect(fetchAndCacheCollectScope).toHaveBeenCalledWith("/repo");
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
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"preCommitHook"'));
    // Doctor's hook-fired check expects every later local commit to reach
    // prim — from activation on, since the entrypoint skips inactive repos.
    expect(recordHooksWired).toHaveBeenCalledWith("/repo", { onlyIfAbsent: false });
    const activeWrite = mockedExecFileSync.mock.calls.findIndex(
      (call) => (call[1] as string[]).join(" ") === "config --local prim.active true",
    );
    expect(vi.mocked(recordHooksWired).mock.invocationCallOrder[0]).toBeGreaterThan(
      mockedExecFileSync.mock.invocationCallOrder[activeWrite] ?? Number.POSITIVE_INFINITY,
    );
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("refreshes both owned global hooks before checking effective coverage", async () => {
    inRepo("/repo");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    expect(vi.mocked(stageGitHookRuntime).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(refreshOwnedGlobalHooks).mock.invocationCallOrder[0],
    );
    expect(vi.mocked(refreshOwnedGlobalHooks).mock.invocationCallOrder[0]).toBeLessThan(
      hookCallOrder("pre-commit"),
    );
    expect(hookCallOrder("post-commit")).toBeLessThan(hookCallOrder("post-rewrite"));
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
    expect(hookCallOrder("post-commit")).toBeLessThan(
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
    expect(ensureEffectiveGitHook).not.toHaveBeenCalled();
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
    failHook("post-commit", "malformed Prim hook markers");
    vi.mocked(recordHooksWired).mockClear();
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
    expect(recordHooksWired).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it.each([
    ["post-rewrite", "postRewriteHook"],
    ["pre-commit", "preCommitHook"],
  ] as const)(
    "enables with an explicit degradation when only %s coverage fails",
    async (hookName, field) => {
      inRepo("/repo");
      failHook(hookName, `Husky ${hookName} dispatcher is missing`);
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
        expect.stringContaining(`${hookName} hook coverage is degraded`),
      );
      expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"active": true'));
      expect(logSpy).not.toHaveBeenCalledWith(expect.stringContaining(`"${field}"`));
      logSpy.mockRestore();
      errSpy.mockRestore();
    },
  );

  it("keeps the existing expectation when re-enabling changes nothing", async () => {
    inRepo("/repo", { active: true });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await buildProgram().parseAsync(["enable"], { from: "user" });
    expect(recordHooksWired).toHaveBeenCalledWith("/repo", { onlyIfAbsent: true });
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("starts no expectation when activation does not happen", async () => {
    inRepo("/repo");
    vi.mocked(bindRepository).mockResolvedValue({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    vi.stubEnv("CI", "1");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await buildProgram().parseAsync(["enable"], { from: "user" });
    expect(recordHooksWired).not.toHaveBeenCalled();
    logSpy.mockRestore();
    errSpy.mockRestore();
  });

  it("never edits a shared hooks dir: post-commit outside the repo fails enable", async () => {
    inRepo("/repo");
    vi.mocked(ensureEffectiveGitHook).mockImplementation((hookName) =>
      hookResult(hookName, "external"),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
      throw new Error(`exit ${code}`);
    });
    await expect(buildProgram().parseAsync(["enable"], { from: "user" })).rejects.toThrow(/exit 1/);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("outside the repository"));
    expect(bindRepository).not.toHaveBeenCalled();
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("reports manual wiring instead of writing hooks under prim.gitHooks=manual", async () => {
    inRepo("/repo");
    vi.mocked(ensureEffectiveGitHook).mockImplementation((hookName) =>
      hookResult(hookName, "manual"),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await buildProgram().parseAsync(["enable"], { from: "user" });

    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("prim.gitHooks=manual"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('"active": true'));
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
