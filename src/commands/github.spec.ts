import { readFileSync } from "node:fs";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError } from "../client.js";
import {
  type GithubConnectDependencies,
  performGithubConnect,
  registerGithubCommands,
} from "./github.js";

const CONNECTED = {
  status: "connected",
  repoSyncId: "repoSync123",
  repositoryFullName: "campus-ai/primitive",
} as const;
const UNBOUND = {
  status: "unbound",
  repositoryFullName: "campus-ai/primitive",
} as const;
const ORIGINAL_EXIT_CODE = process.exitCode;

function dependencies(): GithubConnectDependencies {
  return {
    cwd: vi.fn(() => "/repo/packages/cli"),
    gitToplevel: vi.fn(() => "/repo"),
    bindRepository: vi.fn(async () => CONNECTED),
  };
}

function program(deps: GithubConnectDependencies): Command {
  const root = new Command().exitOverride();
  root.option("--non-interactive", "fail fast instead of prompting");
  registerGithubCommands(root, deps);
  return root;
}

beforeEach(() => {
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
  vi.restoreAllMocks();
});

describe("prim github connect", () => {
  it("registers the nested command and documents the existing-access boundary", () => {
    const deps = dependencies();
    const root = program(deps);
    const github = root.commands.find((command) => command.name() === "github");
    const connect = github?.commands.find((command) => command.name() === "connect");

    expect(github).toBeDefined();
    expect(connect).toBeDefined();
    expect(connect?.description()).toContain("current GitHub origin");
    expect(connect?.description()).toContain("does not install or change GitHub App access");
  });

  it("has no activation, hook-installation, browser, or prompt dependency", () => {
    const source = readFileSync(new URL("./github.ts", import.meta.url), "utf8");

    for (const forbidden of [
      "setRepoActive",
      "ensureEffectivePostCommitHook",
      "ensureEffectivePostRewriteHook",
      "daemonRequest",
      "askConfirmation",
      "getClient",
    ]) {
      expect(source).not.toContain(forbidden);
    }
  });

  it("emits the exact connected JSON and verdict without claiming installation", async () => {
    const deps = dependencies();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(deps.gitToplevel).toHaveBeenCalledWith("/repo/packages/cli");
    expect(deps.bindRepository).toHaveBeenCalledWith(
      "/repo",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "[prim] repository binding connected for GitHub origin campus-ai/primitive\n",
    );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify(CONNECTED, null, 2));
    expect(stderr.mock.calls.join(" ")).not.toMatch(/install(?:ed|ation) success/iu);
    expect(process.exitCode).toBe(0);
  });

  it("emits exact unbound JSON, preserves the binding helper boundary, and exits nonzero", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepository).mockResolvedValueOnce(UNBOUND);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(deps.bindRepository).toHaveBeenCalledOnce();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "[prim] repository binding unbound for GitHub origin campus-ai/primitive; no GitHub App installation or access was changed\n",
    );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify(UNBOUND, null, 2));
    expect(String(stdout.mock.calls[0]?.[0])).not.toContain("repoSyncId");
    expect(process.exitCode).toBe(2);
  });

  it("fails closed outside a git repository without attempting a binding", async () => {
    const deps = dependencies();
    vi.mocked(deps.gitToplevel).mockReturnValueOnce(null);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(deps.bindRepository).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "[prim] github connect failed: not a git repository — run `prim github connect` inside a GitHub repository\n",
    );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(
        {
          status: "error",
          error: "not a git repository — run `prim github connect` inside a GitHub repository",
        },
        null,
        2,
      ),
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails closed for a non-GitHub origin and reports no connected output", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepository).mockRejectedValueOnce(
      new Error("origin must be a GitHub HTTPS/SSH remote in owner/name form"),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "[prim] github connect failed: origin must be a GitHub HTTPS/SSH remote in owner/name form\n",
    );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(
        {
          status: "error",
          error: "origin must be a GitHub HTTPS/SSH remote in owner/name form",
        },
        null,
        2,
      ),
    );
    expect(String(stdout.mock.calls[0]?.[0])).not.toContain('"status": "connected"');
    expect(process.exitCode).toBe(1);
  });

  it("sanitizes terminal controls for people while retaining the raw JSON error", async () => {
    const deps = dependencies();
    const message = "origin campus\u202e-ai/pr\u200bimitive\nnot allowed";
    vi.mocked(deps.bindRepository).mockRejectedValueOnce(new Error(message));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "[prim] github connect failed: origin campus-ai/primitive not allowed\n",
    );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ status: "error", error: message }, null, 2),
    );
  });

  it("reports authentication errors with their HTTP status and no success output", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepository).mockRejectedValueOnce(
      new HttpError(401, "Authentication expired. Run `prim auth login` to re-authenticate."),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "[prim] github connect failed: Authentication expired. Run `prim auth login` to re-authenticate.\n",
    );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(
        {
          status: "error",
          error: "Authentication expired. Run `prim auth login` to re-authenticate.",
          httpStatus: 401,
        },
        null,
        2,
      ),
    );
    expect(String(stdout.mock.calls[0]?.[0])).not.toContain('"status": "connected"');
    expect(process.exitCode).toBe(1);
  });

  it("runs noninteractively without a prompt or activation option", async () => {
    const deps = dependencies();
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await program(deps).parseAsync(["--non-interactive", "github", "connect"], {
      from: "user",
    });

    expect(deps.bindRepository).toHaveBeenCalledOnce();
    const github = program(deps).commands.find((command) => command.name() === "github");
    const connect = github?.commands.find((command) => command.name() === "connect");
    expect(connect?.options).toEqual([]);
    expect(process.exitCode).toBe(0);
  });
});
