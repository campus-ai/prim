import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockDaemonRequest } = vi.hoisted(() => ({
  mockDaemonRequest: vi.fn(),
}));

vi.mock("./client.js", () => ({
  daemonRequest: mockDaemonRequest,
}));

import type { CliClient } from "../client.js";
import { daemonOrDirectGet } from "./proxy.js";

function clientWith(overrides: Partial<CliClient>): CliClient {
  const unexpected = vi.fn().mockRejectedValue(new Error("unexpected call"));
  return {
    get: overrides.get ?? unexpected,
    post: overrides.post ?? unexpected,
  };
}

beforeEach(() => {
  mockDaemonRequest.mockReset();
});

describe("daemon proxy reads", () => {
  it("returns a daemon GET result without calling direct HTTP", async () => {
    mockDaemonRequest.mockResolvedValueOnce({ decisions: [] });
    const get = vi.fn();
    const client = clientWith({ get });

    const result = await daemonOrDirectGet("decisions_recent", "/api/cli/decisions/recent", client);

    expect(result).toEqual({ decisions: [] });
    expect(mockDaemonRequest).toHaveBeenCalledWith(
      "decisions_recent",
      { path: "/api/cli/decisions/recent" },
      { timeoutMs: 250 },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to direct GET and returns its result when the daemon is unavailable", async () => {
    mockDaemonRequest.mockResolvedValueOnce(null);
    const get = vi.fn().mockResolvedValueOnce({ decisions: [] });
    const client = clientWith({ get });

    const result = await daemonOrDirectGet(
      "decisions_recent",
      "/api/cli/decisions/recent",
      client,
      1234,
    );

    expect(result).toEqual({ decisions: [] });
    expect(get).toHaveBeenCalledWith("/api/cli/decisions/recent", {
      signal: expect.any(AbortSignal),
    });
  });

  it("probes the local daemon on a short budget, not the caller's HTTP deadline", async () => {
    mockDaemonRequest.mockResolvedValueOnce(null);
    const get = vi.fn().mockResolvedValueOnce({ decisions: [] });
    const client = clientWith({ get });

    // Even with a 10s direct deadline, the local-socket probe stays short so a
    // no-daemon cold path never waits both timeouts back-to-back.
    await daemonOrDirectGet("decisions_recent", "/api/cli/decisions/recent", client, 10_000);

    expect(mockDaemonRequest).toHaveBeenCalledWith(
      "decisions_recent",
      { path: "/api/cli/decisions/recent" },
      { timeoutMs: 250 },
    );
  });
});
