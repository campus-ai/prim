import { readFileSync } from "node:fs";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";
import { HttpError } from "../client.js";
import type {
  GitHubInstallIntentStart,
  GitHubInstallIntentStatus,
} from "../lib/github-install-intent.js";
import {
  type GithubConnectDependencies,
  performGithubConnect,
  registerGithubCommands,
} from "./github.js";

const NOW = 1_800_000_000_000;
const CONNECTED = {
  status: "connected",
  repoSyncId: "repoSync123",
  repositoryFullName: "campus-ai/primitive",
} as const;
const UNBOUND = {
  status: "unbound",
  repositoryFullName: "campus-ai/primitive",
} as const;
const START: GitHubInstallIntentStart = {
  protocolVersion: 1,
  mode: "install_intent_v1",
  status: "pending",
  intentId: "intent123",
  browserUrl: `https://github.com/apps/primitive/installations/new?state=${"a".repeat(64)}`,
  expiresAt: NOW + 60_000,
  pollAfterMs: 1000,
};
const CONSUMED: GitHubInstallIntentStatus = {
  protocolVersion: 1,
  mode: "install_intent_v1",
  found: true,
  status: "consumed",
  expiresAt: START.expiresAt,
  completedAt: NOW + 2_000,
  repositoryCount: 2,
  adminRepositoryCount: 1,
  nonAdminRepositoryCount: 1,
};
const ORIGINAL_EXIT_CODE = process.exitCode;

function dependencies(): GithubConnectDependencies {
  const client: CliClient = {
    get: vi.fn(),
    post: vi.fn(),
  };
  return {
    cwd: vi.fn(() => "/repo/packages/cli"),
    gitToplevel: vi.fn(() => "/repo"),
    bindRepositoryWithClient: vi.fn(async () => CONNECTED),
    getPinnedClient: vi.fn(async () => client),
    createInstallIntent: vi.fn(async () => START),
    pollInstallIntent: vi.fn(async () => CONSUMED),
    openBrowser: vi.fn(),
    now: vi.fn(() => NOW),
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
  it("registers an explicit browser-suppression option", () => {
    const root = program(dependencies());
    const github = root.commands.find((command) => command.name() === "github");
    const connect = github?.commands.find((command) => command.name() === "connect");

    expect(connect?.description()).toContain("Install or reuse");
    expect(connect?.options.map(({ long }) => long)).toEqual(["--no-browser"]);
  });

  it("keeps the flow on the ordinary pinned bearer and outside activation/API-key management", () => {
    const source = readFileSync(new URL("./github.ts", import.meta.url), "utf8");

    expect(source).toContain("getPinnedClient");
    for (const forbidden of [
      "getPinnedManagementClient",
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

  it("returns an existing binding without creating or opening an intent", async () => {
    const deps = dependencies();
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(deps.getPinnedClient).toHaveBeenCalledExactlyOnceWith({
      signal: expect.any(AbortSignal),
    });
    expect(deps.bindRepositoryWithClient).toHaveBeenCalledExactlyOnceWith(
      "/repo",
      expect.objectContaining({ get: expect.any(Function), post: expect.any(Function) }),
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(deps.createInstallIntent).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(stderr).toHaveBeenCalledExactlyOnceWith(
      "[prim] repository binding connected for GitHub origin campus-ai/primitive\n",
    );
    expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify(CONNECTED, null, 2));
    expect(process.exitCode).toBe(0);
  });

  it("runs the canonical intent, browser, poll, and final binding sequence on one pinned client", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepositoryWithClient)
      .mockResolvedValueOnce(UNBOUND)
      .mockResolvedValueOnce(CONNECTED);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(deps.bindRepositoryWithClient).toHaveBeenCalledTimes(2);
    expect(deps.getPinnedClient).toHaveBeenCalledExactlyOnceWith({
      signal: expect.any(AbortSignal),
    });
    expect(deps.createInstallIntent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ get: expect.any(Function), post: expect.any(Function) }),
      { signal: expect.any(AbortSignal), now: NOW },
    );
    expect(deps.openBrowser).toHaveBeenCalledExactlyOnceWith(START.browserUrl);
    expect(deps.pollInstallIntent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ get: expect.any(Function), post: expect.any(Function) }),
      START,
      { now: deps.now },
    );
    const pinnedClient = await vi.mocked(deps.getPinnedClient).mock.results[0]?.value;
    expect(deps.bindRepositoryWithClient).toHaveBeenNthCalledWith(
      1,
      "/repo",
      pinnedClient,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(deps.bindRepositoryWithClient).toHaveBeenNthCalledWith(
      2,
      "/repo",
      pinnedClient,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(stderr.mock.calls.join("")).toContain(START.browserUrl);
    expect(stderr.mock.calls.join("")).toContain("1 admin repositories (2 total)");
    expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify(CONNECTED, null, 2));
    expect(process.exitCode).toBe(0);
  });

  it("prints but does not open the URL with --no-browser", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepositoryWithClient)
      .mockResolvedValueOnce(UNBOUND)
      .mockResolvedValueOnce(CONNECTED);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await program(deps).parseAsync(["github", "connect", "--no-browser"], { from: "user" });

    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join("")).toContain(START.browserUrl);
    expect(deps.pollInstallIntent).toHaveBeenCalledOnce();
  });

  it("suppresses the browser in global non-interactive mode", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepositoryWithClient)
      .mockResolvedValueOnce(UNBOUND)
      .mockResolvedValueOnce(CONNECTED);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await program(deps).parseAsync(["--non-interactive", "github", "connect"], {
      from: "user",
    });

    expect(deps.openBrowser).not.toHaveBeenCalled();
    expect(deps.pollInstallIntent).toHaveBeenCalledOnce();
  });

  it("truthfully reports a consumed installation that did not bind this repository", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepositoryWithClient).mockResolvedValue(UNBOUND);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps, { browser: false });

    expect(stderr.mock.calls.join("")).toContain("was not granted admin access");
    expect(stdout).toHaveBeenCalledExactlyOnceWith(JSON.stringify(UNBOUND, null, 2));
    expect(process.exitCode).toBe(2);
  });

  it("fails closed on a terminal installation failure without retrying the bind", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepositoryWithClient).mockResolvedValueOnce(UNBOUND);
    vi.mocked(deps.pollInstallIntent).mockResolvedValueOnce({
      protocolVersion: 1,
      mode: "install_intent_v1",
      found: true,
      status: "failed_terminal",
      expiresAt: START.expiresAt,
      closedAt: NOW + 2_000,
      failureCode: "authority_changed",
    });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps, { browser: false });

    expect(deps.bindRepositoryWithClient).toHaveBeenCalledOnce();
    expect(stderr.mock.calls.join("")).toContain("GitHub installation failed: authority_changed");
    expect(stdout).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify(
        { status: "error", error: "GitHub installation failed: authority_changed" },
        null,
        2,
      ),
    );
    expect(process.exitCode).toBe(1);
  });

  it("fails closed outside a git repository without network or browser work", async () => {
    const deps = dependencies();
    vi.mocked(deps.gitToplevel).mockReturnValueOnce(null);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(deps.bindRepositoryWithClient).not.toHaveBeenCalled();
    expect(deps.getPinnedClient).not.toHaveBeenCalled();
    expect(deps.openBrowser).not.toHaveBeenCalled();
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
  });

  it("reports authentication errors without creating an intent", async () => {
    const deps = dependencies();
    vi.mocked(deps.bindRepositoryWithClient).mockRejectedValueOnce(
      new HttpError(401, "Authentication expired. Run `prim auth login` to re-authenticate."),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performGithubConnect(deps);

    expect(deps.createInstallIntent).not.toHaveBeenCalled();
    expect(stderr.mock.calls.join("")).toContain("Authentication expired");
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
  });

  it("sanitizes terminal controls for people while retaining the raw JSON error", async () => {
    const deps = dependencies();
    const message = "origin campus\u202e-ai/pr\u200bimitive\nnot allowed";
    vi.mocked(deps.bindRepositoryWithClient).mockRejectedValueOnce(new Error(message));
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
});
