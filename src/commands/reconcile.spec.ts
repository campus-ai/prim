import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockPost = vi.fn();
vi.mock("../client.js", () => ({
  getClient: () => ({ post: mockPost, get: vi.fn(), patch: vi.fn(), delete: vi.fn() }),
}));

import { performReconcile } from "./reconcile.js";

const ORIGINAL_EXIT_CODE = process.exitCode;

beforeEach(() => {
  mockPost.mockReset();
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
});

describe("performReconcile", () => {
  it("emits ok JSON + verdict line on successful bypass issuance", async () => {
    const expiresAt = Date.now() + 5 * 60 * 1000;
    mockPost.mockResolvedValueOnce({
      ok: true,
      bypassId: "bpyx1",
      token: "abc123def456",
      issuedAt: Date.now(),
      expiresAt,
      decisionId: "dec_id",
      decisionShortId: "abc12345",
      conflictFlagId: "flag_id",
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const stdoutSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_abc12345");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile token issued for dec_abc12345"),
    );
    expect(stdoutSpy).toHaveBeenCalled();
    expect(process.exitCode).toBe(0);

    stderrSpy.mockRestore();
    stdoutSpy.mockRestore();
  });

  it("passes the --flag arg through as conflictFlagId in the request body", async () => {
    mockPost.mockResolvedValueOnce({
      ok: true,
      bypassId: "id",
      token: "t",
      issuedAt: 1,
      expiresAt: 2,
      decisionId: "did",
      decisionShortId: "short",
      conflictFlagId: "specific-flag",
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_short", { flag: "specific-flag" });

    expect(mockPost).toHaveBeenCalledWith("/api/cli/reconcile/consume", {
      idOrShortId: "dec_short",
      conflictFlagId: "specific-flag",
    });
  });

  it("omits conflictFlagId from the body when --flag is not supplied", async () => {
    mockPost.mockResolvedValueOnce({
      ok: true,
      bypassId: "id",
      token: "t",
      issuedAt: 1,
      expiresAt: 2,
      decisionId: "did",
      decisionShortId: "short",
      conflictFlagId: "flag",
    });
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_short");

    expect(mockPost).toHaveBeenCalledWith("/api/cli/reconcile/consume", {
      idOrShortId: "dec_short",
    });
  });

  it("renders rejection reasons with exit code 2", async () => {
    mockPost.mockResolvedValueOnce({
      ok: false,
      reason: "no_pending_flag",
    });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_xyz");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile rejected: no_pending_flag"),
    );
    expect(process.exitCode).toBe(2);
    stderrSpy.mockRestore();
  });

  it("handles network / HTTP errors with exit code 3", async () => {
    mockPost.mockRejectedValueOnce(new Error("HTTP 500"));
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_xyz");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile failed: HTTP 500"),
    );
    expect(process.exitCode).toBe(3);
    stderrSpy.mockRestore();
  });

  it("flags malformed server responses with exit code 3", async () => {
    mockPost.mockResolvedValueOnce({ unknown: "shape" });
    const stderrSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    vi.spyOn(console, "log").mockImplementation(() => undefined);

    await performReconcile("dec_xyz");

    expect(stderrSpy).toHaveBeenCalledWith(
      expect.stringContaining("[prim] reconcile: malformed server response"),
    );
    expect(process.exitCode).toBe(3);
    stderrSpy.mockRestore();
  });
});
