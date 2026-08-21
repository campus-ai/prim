/**
 * `checkRepositoryBinding` — the side-effecting wrapper the pure classifier
 * cannot cover. It resolves the live server binding, then folds in whether the
 * checkout is active for capture. The active/inactive wiring only changes the
 * verdict on the pending path, so these tests pin that the wrapper feeds the
 * real `isRepoActiveForCapture` result to the classifier (an inverted wire
 * would flip warn<->fail) and that an unreachable server bounds into an
 * actionable fail rather than an unbounded network string.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { resolveRepositoryBinding } from "../lib/repository-binding.js";
import { checkRepositoryBinding } from "./doctor.js";

vi.mock("../lib/repository-binding.js", () => ({
  resolveRepositoryBinding: vi.fn(),
}));
vi.mock("../lib/activation.js", () => ({
  isValidRepoSyncId: (value: unknown) =>
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/u.test(value),
  isRepoActiveForCapture: vi.fn(),
  repoSyncId: vi.fn(),
}));

const CONNECTED = {
  status: "connected",
  repoSyncId: "repoSync123",
  repositoryFullName: "campus-ai/primitive",
} as const;
const UNBOUND = {
  status: "unbound",
  repositoryFullName: "campus-ai/primitive",
} as const;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(repoSyncId).mockReturnValue(undefined);
  vi.mocked(isRepoActiveForCapture).mockReturnValue(false);
});

describe("checkRepositoryBinding wiring", () => {
  it("degrades an active checkout with an unbound server connection to warn", async () => {
    vi.mocked(resolveRepositoryBinding).mockResolvedValue(UNBOUND);
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);

    await expect(checkRepositoryBinding()).resolves.toMatchObject({
      name: "repo-binding",
      status: "warn",
      detail: expect.stringContaining("repository is unbound"),
    });
  });

  it("fails an inactive checkout with an unbound server connection and asks for enable", async () => {
    vi.mocked(resolveRepositoryBinding).mockResolvedValue(UNBOUND);
    vi.mocked(isRepoActiveForCapture).mockReturnValue(false);

    await expect(checkRepositoryBinding()).resolves.toMatchObject({
      name: "repo-binding",
      status: "fail",
      detail: expect.stringContaining("prim enable"),
    });
  });

  it("passes a matched connected binding through as ok", async () => {
    vi.mocked(resolveRepositoryBinding).mockResolvedValue(CONNECTED);
    vi.mocked(repoSyncId).mockReturnValue("repoSync123");
    vi.mocked(isRepoActiveForCapture).mockReturnValue(true);

    await expect(checkRepositoryBinding()).resolves.toMatchObject({
      name: "repo-binding",
      status: "ok",
    });
  });

  it("bounds an unreachable server into an actionable fail", async () => {
    vi.mocked(resolveRepositoryBinding).mockRejectedValue(new Error("network unavailable"));

    const check = await checkRepositoryBinding();

    expect(check).toMatchObject({ name: "repo-binding", status: "fail" });
    expect(check.detail).toContain("could not verify the current repository binding");
  });
});
