import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";

const { mockDaemonRequest } = vi.hoisted(() => ({
  mockDaemonRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock("../daemon/client.js", () => ({
  daemonRequest: mockDaemonRequest,
}));

import { CascadeNotFoundError, type CascadeResult, fetchCascade } from "./cascade.js";

const RESULT: CascadeResult = {
  decision: {
    id: "qx7fpmycwabtzke040y7vecnnh8870pg",
    shortId: "230a72aa",
    intent: "Keep WorkOS as the auth provider",
    area: "auth",
    authorName: "Taylor",
    classifiedAt: Date.UTC(2026, 5, 7, 19, 9, 37),
    status: "active",
  },
  rationale: "Single issuer",
  reversibility: "low",
  fanOut: 2,
  upstream: {
    files: ["convex/auth.config.ts"],
    contexts: [],
  },
  downstream: [],
  trigger: null,
  truncated: false,
};

function clientWith(get: CliClient["get"]): CliClient {
  const unexpected = () => {
    throw new Error("unexpected non-GET call");
  };
  return {
    get,
    post: unexpected,
  };
}

describe("fetchCascade", () => {
  beforeEach(() => {
    mockDaemonRequest.mockReset();
    mockDaemonRequest.mockResolvedValue(null);
  });

  it("uses the daemon cascade proxy when available", async () => {
    mockDaemonRequest.mockResolvedValueOnce(RESULT);
    const get = vi.fn().mockResolvedValue(undefined);

    const result = await fetchCascade("dec_230a72aa", { getClient: () => clientWith(get) });

    expect(result).toEqual(RESULT);
    expect(mockDaemonRequest).toHaveBeenCalledWith(
      "decisions_cascade",
      expect.objectContaining({ path: "/api/cli/decisions/cascade?id=dec_230a72aa" }),
      { timeoutMs: 250 },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to a direct cascade fetch when the daemon is down", async () => {
    mockDaemonRequest.mockResolvedValueOnce(null);
    const get = vi.fn().mockResolvedValueOnce(RESULT);

    const result = await fetchCascade("dec_230a72aa", { getClient: () => clientWith(get) });

    expect(result).toEqual(RESULT);
    expect(get).toHaveBeenCalledWith("/api/cli/decisions/cascade?id=dec_230a72aa", {
      signal: expect.any(AbortSignal),
    });
  });

  it("normalizes a projection that omits upstream.contexts to an empty array", async () => {
    // The server drops `upstream.contexts` entirely when a decision references
    // no contexts. The raw payload therefore violates CascadeResult at runtime;
    // fetchCascade must backfill it so downstream consumers never see undefined.
    const sparse = {
      ...RESULT,
      upstream: { files: RESULT.upstream.files },
    };
    mockDaemonRequest.mockResolvedValueOnce(sparse);
    const get = vi.fn().mockResolvedValue(undefined);

    const result = await fetchCascade("dec_230a72aa", { getClient: () => clientWith(get) });

    expect(result.upstream.contexts).toEqual([]);
    expect(result.upstream.files).toEqual(RESULT.upstream.files);
  });

  it("maps a not-found error to CascadeNotFoundError on the direct path", async () => {
    mockDaemonRequest.mockResolvedValueOnce(null);
    const get = vi.fn().mockRejectedValueOnce(new Error("Decision not found: dec_230a72aa"));

    await expect(
      fetchCascade("dec_230a72aa", { getClient: () => clientWith(get) }),
    ).rejects.toBeInstanceOf(CascadeNotFoundError);
  });
});
