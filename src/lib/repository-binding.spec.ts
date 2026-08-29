import { beforeEach, describe, expect, it, vi } from "vitest";
import { HttpError, getClient } from "../client.js";
import { clearRepoSyncId, setRepoSyncId, setRepositoryBindingState } from "./activation.js";
import { githubRepositoryFullName } from "./git.js";
import {
  bindRepository,
  bindRepositoryWithClient,
  resolveRepositoryBinding,
  resolveRepositoryBindingWithClient,
} from "./repository-binding.js";

vi.mock("../client.js", () => ({
  getClient: vi.fn(),
  HttpError: class HttpError extends Error {
    readonly status: number;

    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));
vi.mock("./activation.js", () => ({
  clearRepoSyncId: vi.fn(),
  isValidRepoSyncId: (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value),
  setRepoSyncId: vi.fn(),
  setRepositoryBindingState: vi.fn(),
}));
vi.mock("./git.js", () => ({ githubRepositoryFullName: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(githubRepositoryFullName).mockReturnValue("campus-ai/primitive");
  vi.mocked(getClient).mockReturnValue({
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ repoSyncId: "repoSync123" }),
  });
});

describe("bindRepository", () => {
  it("uses an injected client and preserves origin-scoped persistence", async () => {
    const client = { post: vi.fn().mockResolvedValue({ repoSyncId: "repoSync123" }) };

    await expect(bindRepositoryWithClient("/repo", client)).resolves.toEqual({
      status: "connected",
      repoSyncId: "repoSync123",
      repositoryFullName: "campus-ai/primitive",
    });

    expect(client.post).toHaveBeenCalledWith(
      "/api/cli/repositories/bind",
      { repositoryFullName: "campus-ai/primitive" },
      undefined,
    );
    expect(setRepoSyncId).toHaveBeenCalledWith("/repo", "repoSync123", "campus-ai/primitive");
    expect(getClient).not.toHaveBeenCalled();
  });

  it("resolves through an injected client without persisting local state", async () => {
    const client = { post: vi.fn().mockResolvedValue({ repoSyncId: "repoSync123" }) };

    await expect(resolveRepositoryBindingWithClient("/repo", client)).resolves.toMatchObject({
      status: "connected",
    });
    expect(setRepoSyncId).not.toHaveBeenCalled();
    expect(setRepositoryBindingState).not.toHaveBeenCalled();
    expect(getClient).not.toHaveBeenCalled();
  });

  it("can verify the current binding without mutating local Git config", async () => {
    await expect(resolveRepositoryBinding("/repo")).resolves.toEqual({
      status: "connected",
      repoSyncId: "repoSync123",
      repositoryFullName: "campus-ai/primitive",
    });
    expect(setRepoSyncId).not.toHaveBeenCalled();
    expect(setRepositoryBindingState).not.toHaveBeenCalled();
  });

  it("persists only the authenticated server-issued binding", async () => {
    const signal = AbortSignal.timeout(1_000);
    await expect(bindRepository("/repo", { signal, quietRefresh: true })).resolves.toEqual({
      status: "connected",
      repoSyncId: "repoSync123",
      repositoryFullName: "campus-ai/primitive",
    });
    expect(vi.mocked(getClient)().post).toHaveBeenCalledWith(
      "/api/cli/repositories/bind",
      { repositoryFullName: "campus-ai/primitive" },
      { signal, quietRefresh: true },
    );
    expect(setRepoSyncId).toHaveBeenCalledWith("/repo", "repoSync123", "campus-ai/primitive");
    expect(setRepositoryBindingState).toHaveBeenCalledWith("/repo", "connected");
    expect(clearRepoSyncId).not.toHaveBeenCalled();
  });

  it("reports an authoritative 404 as unbound without mutating during resolution", async () => {
    vi.mocked(getClient)().post = vi
      .fn()
      .mockRejectedValue(new HttpError(404, "Repository is not connected"));
    await expect(resolveRepositoryBinding("/repo")).resolves.toEqual({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    expect(setRepoSyncId).not.toHaveBeenCalled();
    expect(clearRepoSyncId).not.toHaveBeenCalled();
    expect(setRepositoryBindingState).not.toHaveBeenCalled();
  });

  it("retains the last binding and records unbound when the server returns 404", async () => {
    vi.mocked(getClient)().post = vi
      .fn()
      .mockRejectedValue(new HttpError(404, "Repository is not connected"));
    await expect(bindRepository("/repo")).resolves.toEqual({
      status: "unbound",
      repositoryFullName: "campus-ai/primitive",
    });
    expect(clearRepoSyncId).not.toHaveBeenCalled();
    expect(setRepoSyncId).not.toHaveBeenCalled();
    expect(setRepositoryBindingState).toHaveBeenCalledWith("/repo", "unbound");
  });

  it("rejects a non-GitHub origin before the request", async () => {
    vi.mocked(githubRepositoryFullName).mockReturnValue(null);
    await expect(bindRepository("/repo")).rejects.toThrow("origin must be a GitHub");
    expect(vi.mocked(getClient)().post).not.toHaveBeenCalled();
  });

  it.each([{}, { repoSyncId: "" }, { repoSyncId: 1 }, { repoSyncId: "-leading" }])(
    "never persists an invalid response",
    async (response) => {
      vi.mocked(getClient)().post = vi.fn().mockResolvedValue(response);
      await expect(bindRepository("/repo")).rejects.toThrow(
        "server returned an invalid repository binding",
      );
      expect(setRepoSyncId).not.toHaveBeenCalled();
      expect(clearRepoSyncId).not.toHaveBeenCalled();
      expect(setRepositoryBindingState).toHaveBeenCalledWith("/repo", "invalid");
    },
  );

  it.each([
    new HttpError(401, "Authentication expired"),
    new HttpError(403, "Forbidden"),
    new HttpError(500, "Internal server error"),
    new Error("network unavailable"),
    Object.assign(new Error("untyped failure"), { status: 404 }),
  ])(
    "propagates every non-authoritative-404 failure without changing local state",
    async (error) => {
      vi.mocked(getClient)().post = vi.fn().mockRejectedValue(error);
      await expect(bindRepository("/repo")).rejects.toBe(error);
      expect(setRepoSyncId).not.toHaveBeenCalled();
      expect(clearRepoSyncId).not.toHaveBeenCalled();
      expect(setRepositoryBindingState).not.toHaveBeenCalled();
    },
  );

  it("propagates an unbound-state write failure without deleting the cached binding", async () => {
    const stateError = new Error("could not write .git/config");
    vi.mocked(getClient)().post = vi
      .fn()
      .mockRejectedValue(new HttpError(404, "Repository is not connected"));
    vi.mocked(setRepositoryBindingState).mockImplementation(() => {
      throw stateError;
    });
    await expect(bindRepository("/repo")).rejects.toBe(stateError);
    expect(clearRepoSyncId).not.toHaveBeenCalled();
    expect(setRepoSyncId).not.toHaveBeenCalled();
  });
});
