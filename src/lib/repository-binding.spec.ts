import { beforeEach, describe, expect, it, vi } from "vitest";
import { getClient } from "../client.js";
import { setRepoSyncId } from "./activation.js";
import { githubRepositoryFullName } from "./git.js";
import { bindRepository } from "./repository-binding.js";

vi.mock("../client.js", () => ({ getClient: vi.fn() }));
vi.mock("./activation.js", () => ({ setRepoSyncId: vi.fn() }));
vi.mock("./git.js", () => ({ githubRepositoryFullName: vi.fn() }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(githubRepositoryFullName).mockReturnValue("campus-ai/primitive");
  vi.mocked(getClient).mockReturnValue({
    get: vi.fn(),
    post: vi.fn().mockResolvedValue({ repoSyncId: "sync-1" }),
  });
});

describe("bindRepository", () => {
  it("persists an authenticated strict-origin binding", async () => {
    const signal = AbortSignal.timeout(1_000);

    await expect(bindRepository("/repo", { signal, quietRefresh: true })).resolves.toEqual({
      repoSyncId: "sync-1",
      repositoryFullName: "campus-ai/primitive",
    });
    expect(vi.mocked(getClient)().post).toHaveBeenCalledWith(
      "/api/cli/repositories/bind",
      { repositoryFullName: "campus-ai/primitive" },
      { signal, quietRefresh: true },
    );
    expect(setRepoSyncId).toHaveBeenCalledWith("/repo", "sync-1");
  });

  it("rejects a non-GitHub origin before the request", async () => {
    vi.mocked(githubRepositoryFullName).mockReturnValue(null);

    await expect(bindRepository("/repo")).rejects.toThrow("origin must be a GitHub");
    expect(vi.mocked(getClient)().post).not.toHaveBeenCalled();
    expect(setRepoSyncId).not.toHaveBeenCalled();
  });

  it.each([{}, { repoSyncId: "" }, { repoSyncId: 1 }])(
    "never persists an invalid response",
    async (response) => {
      vi.mocked(getClient)().post = vi.fn().mockResolvedValue(response);

      await expect(bindRepository("/repo")).rejects.toThrow(
        "server returned no repository binding",
      );
      expect(setRepoSyncId).not.toHaveBeenCalled();
    },
  );

  it("leaves local state unchanged when the request fails", async () => {
    vi.mocked(getClient)().post = vi.fn().mockRejectedValue(new Error("offline"));

    await expect(bindRepository("/repo")).rejects.toThrow("offline");
    expect(setRepoSyncId).not.toHaveBeenCalled();
  });
});
