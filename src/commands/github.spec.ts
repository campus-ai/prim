import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getPinnedClient: vi.fn(),
  gitToplevel: vi.fn(),
  openBrowser: vi.fn(),
  persistRepositoryBinding: vi.fn(),
  resolveRepositoryBindingWithClient: vi.fn(),
}));

vi.mock("../client.js", () => ({ getPinnedClient: mocks.getPinnedClient }));
vi.mock("../lib/git.js", () => ({ gitToplevel: mocks.gitToplevel }));
vi.mock("../lib/repository-binding.js", () => ({
  persistRepositoryBinding: mocks.persistRepositoryBinding,
  resolveRepositoryBindingWithClient: mocks.resolveRepositoryBindingWithClient,
}));
vi.mock("./auth.js", () => ({ openBrowser: mocks.openBrowser }));

import {
  type GitHubConnectDependencies,
  connectGitHubRepository,
  githubAppInstallUrl,
  parseGitHubInstallStart,
  registerGitHubCommands,
} from "./github.js";

const STATE = "a".repeat(64);
const ISSUED_AT = 1_700_000_000_000;
const EXPIRES_AT = ISSUED_AT + 900_000;
const UNBOUND = { status: "unbound" as const, repositoryFullName: "campus-ai/primitive" };
const CONNECTED = {
  status: "connected" as const,
  repositoryFullName: "campus-ai/primitive",
  repoSyncId: "repoSync123",
};
const ORIGINAL_EXIT_CODE = process.exitCode;

function dependencies(overrides: Partial<GitHubConnectDependencies> = {}): {
  deps: GitHubConnectDependencies;
  client: { get: ReturnType<typeof vi.fn>; post: ReturnType<typeof vi.fn> };
  opened: ReturnType<typeof vi.fn>;
  statuses: string[];
} {
  let now = ISSUED_AT;
  const client = {
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({
      mode: "install_intent_v1",
      state: STATE,
      expiresAt: EXPIRES_AT,
    }),
  };
  const opened = vi.fn();
  const statuses: string[] = [];
  return {
    client,
    opened,
    statuses,
    deps: {
      cwd: () => "/repo/nested",
      now: () => now,
      client: async () => client,
      open: opened,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
      writeStatus: (message) => statuses.push(message),
      ...overrides,
    },
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  process.exitCode = 0;
  mocks.gitToplevel.mockReturnValue("/repo");
});
afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("GitHub install protocol", () => {
  it("accepts the exact proof-backed start response and constructs a fixed GitHub URL", () => {
    expect(
      parseGitHubInstallStart(
        { mode: "install_intent_v1", state: STATE, expiresAt: EXPIRES_AT },
        ISSUED_AT,
      ),
    ).toEqual({ mode: "install_intent_v1", state: STATE, expiresAt: EXPIRES_AT });
    expect(githubAppInstallUrl(STATE)).toBe(
      `https://github.com/apps/primitive/installations/new?state=${STATE}`,
    );
  });

  it.each([
    null,
    {},
    { mode: "legacy_bridge" },
    { mode: "install_intent_v1", state: "short", expiresAt: EXPIRES_AT },
    { mode: "install_intent_v1", state: STATE.toUpperCase(), expiresAt: EXPIRES_AT },
    { mode: "install_intent_v1", state: STATE, expiresAt: ISSUED_AT },
    { mode: "install_intent_v1", state: STATE, expiresAt: Number.MAX_VALUE },
  ])("rejects an unsafe or compatibility response %#", (value) => {
    expect(() => parseGitHubInstallStart(value, ISSUED_AT)).toThrow();
  });
});

describe("connectGitHubRepository", () => {
  it("opens the proof-backed install and persists the eventual authoritative binding", async () => {
    mocks.resolveRepositoryBindingWithClient
      .mockResolvedValueOnce(UNBOUND)
      .mockResolvedValueOnce(UNBOUND)
      .mockResolvedValueOnce(CONNECTED);
    const { deps, client, opened, statuses } = dependencies();

    await expect(
      connectGitHubRepository({ browser: true, nonInteractive: false }, deps),
    ).resolves.toEqual({
      connected: true,
      status: "connected",
      repositoryFullName: "campus-ai/primitive",
      repoSyncId: "repoSync123",
    });

    expect(client.post).toHaveBeenCalledWith(
      "/github/install-intents/start",
      undefined,
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(opened).toHaveBeenCalledWith(
      `https://github.com/apps/primitive/installations/new?state=${STATE}`,
    );
    expect(statuses.join("\n")).toContain("campus-ai/primitive");
    expect(mocks.persistRepositoryBinding).toHaveBeenCalledWith("/repo", CONNECTED);
  });

  it("returns an existing connection without issuing an intent or opening a browser", async () => {
    mocks.resolveRepositoryBindingWithClient.mockResolvedValueOnce(CONNECTED);
    const { deps, client, opened } = dependencies();

    await expect(
      connectGitHubRepository({ browser: true, nonInteractive: false }, deps),
    ).resolves.toMatchObject({ connected: true, status: "already_connected" });
    expect(client.post).not.toHaveBeenCalled();
    expect(opened).not.toHaveBeenCalled();
    expect(mocks.persistRepositoryBinding).toHaveBeenCalledWith("/repo", CONNECTED);
  });

  it.each([
    { browser: false, nonInteractive: false },
    { browser: true, nonInteractive: true },
  ])("prints but does not open in no-browser/non-interactive mode %#", async (options) => {
    mocks.resolveRepositoryBindingWithClient
      .mockResolvedValueOnce(UNBOUND)
      .mockResolvedValueOnce(CONNECTED);
    const { deps, opened, statuses } = dependencies();

    await connectGitHubRepository(options, deps);

    expect(opened).not.toHaveBeenCalled();
    expect(statuses[0]).toContain(`state=${STATE}`);
  });

  it("fails before issuing an intent outside a Git repository", async () => {
    mocks.gitToplevel.mockReturnValue(null);
    const { deps, client } = dependencies();

    await expect(
      connectGitHubRepository({ browser: true, nonInteractive: false }, deps),
    ).rejects.toThrow("inside a Git repository");
    expect(client.post).not.toHaveBeenCalled();
  });

  it("does not downgrade a legacy-bridge response", async () => {
    mocks.resolveRepositoryBindingWithClient.mockResolvedValueOnce(UNBOUND);
    const { deps, client, opened } = dependencies();
    client.post.mockResolvedValueOnce({ mode: "legacy_bridge" });

    await expect(
      connectGitHubRepository({ browser: true, nonInteractive: false }, deps),
    ).rejects.toThrow("Proof-backed GitHub connection is not enabled");
    expect(opened).not.toHaveBeenCalled();
  });

  it("bounds polling by the server intent expiry", async () => {
    mocks.resolveRepositoryBindingWithClient.mockResolvedValue(UNBOUND);
    let now = ISSUED_AT;
    const { deps, opened } = dependencies({
      now: () => now,
      sleep: async (milliseconds) => {
        now += milliseconds;
      },
    });

    await expect(
      connectGitHubRepository({ browser: true, nonInteractive: false }, deps),
    ).rejects.toThrow("timed out");
    expect(opened).toHaveBeenCalledOnce();
    expect(now).toBe(EXPIRES_AT);
  });

  it("does not persist a partial result when polling fails", async () => {
    const failure = new Error("network unavailable");
    mocks.resolveRepositoryBindingWithClient
      .mockResolvedValueOnce(UNBOUND)
      .mockRejectedValueOnce(failure);
    const { deps } = dependencies();

    await expect(
      connectGitHubRepository({ browser: true, nonInteractive: false }, deps),
    ).rejects.toBe(failure);
    expect(mocks.persistRepositoryBinding).not.toHaveBeenCalled();
  });
});

describe("github command", () => {
  it("registers the canonical command and emits machine-readable failure", async () => {
    mocks.gitToplevel.mockReturnValue(null);
    mocks.getPinnedClient.mockResolvedValue({ get: vi.fn(), post: vi.fn() });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    program.option("--non-interactive").exitOverride();
    registerGitHubCommands(program);

    await program.parseAsync(["github", "connect", "--no-browser"], { from: "user" });

    expect(stderr).toHaveBeenCalledWith(expect.stringContaining("GitHub connection failed"));
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({ connected: false, error: "github_connect_failed" }, null, 2),
    );
    expect(process.exitCode).toBe(1);
  });
});
