import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "../client.js";
import { setRepoSyncId } from "./activation.js";
import { githubRepositoryFullName } from "./git.js";
import { bindRepository, resolveRepositoryBinding } from "./repository-binding.js";

vi.mock("../client.js", () => ({ getClient: vi.fn() }));
vi.mock("./activation.js", () => ({
  isValidRepoSyncId: (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value),
  setRepoSyncId: vi.fn(),
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
  it("can verify the current binding without mutating local Git config", async () => {
    await expect(resolveRepositoryBinding("/repo")).resolves.toEqual({
      repoSyncId: "repoSync123",
      repositoryFullName: "campus-ai/primitive",
    });
    expect(setRepoSyncId).not.toHaveBeenCalled();
  });

  it("persists only the authenticated server-issued binding", async () => {
    const signal = AbortSignal.timeout(1_000);
    await expect(bindRepository("/repo", { signal, quietRefresh: true })).resolves.toEqual({
      repoSyncId: "repoSync123",
      repositoryFullName: "campus-ai/primitive",
    });
    expect(vi.mocked(getClient)().post).toHaveBeenCalledWith(
      "/api/cli/repositories/bind",
      { repositoryFullName: "campus-ai/primitive" },
      { signal, quietRefresh: true },
    );
    expect(setRepoSyncId).toHaveBeenCalledWith("/repo", "repoSync123");
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
        "server returned no repository binding",
      );
      expect(setRepoSyncId).not.toHaveBeenCalled();
    },
  );
});
