import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";

const { mockDaemonRequest } = vi.hoisted(() => ({
  mockDaemonRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock("../daemon/client.js", () => ({
  daemonRequest: mockDaemonRequest,
}));

import { checkAffectedDecisions, formatDecisionsWarning } from "./decisions-check.js";

function clientWith(get: ReturnType<typeof vi.fn>): CliClient {
  return { get, post: vi.fn() } as unknown as CliClient;
}

describe("checkAffectedDecisions", () => {
  beforeEach(() => {
    mockDaemonRequest.mockReset();
    mockDaemonRequest.mockResolvedValue(null);
  });

  it("returns a verified-clear result without calling the server when no files are supplied", async () => {
    const get = vi.fn();
    const result = await checkAffectedDecisions([], { getClient: () => clientWith(get) });
    expect(result).toEqual({ decisions: [], truncated: false });
    expect(get).not.toHaveBeenCalled();
  });

  it("sends one repeated files= param per path (never comma-joined)", async () => {
    const get = vi.fn().mockResolvedValue({ decisions: [], truncated: false });
    await checkAffectedDecisions(["src/a.ts", "src/b.ts"], { getClient: () => clientWith(get) });
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("files=src%2Fa.ts");
    expect(url).toContain("files=src%2Fb.ts");
    expect(url).not.toContain("%2C");
  });

  it("uses the daemon affecting proxy when available", async () => {
    mockDaemonRequest.mockResolvedValueOnce({ decisions: [], truncated: false });
    const get = vi.fn();
    await checkAffectedDecisions(["src/a.ts"], { getClient: () => clientWith(get) });

    expect(mockDaemonRequest).toHaveBeenCalledWith(
      "decisions_affecting",
      { path: "/api/cli/decisions/affecting?files=src%2Fa.ts" },
      { timeoutMs: 250 },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("chunks at the 25-path cap and merges decisions across chunks (dedupe by id, union files)", async () => {
    const files = Array.from({ length: 30 }, (_, i) => `src/f${String(i)}.ts`);
    const get = vi
      .fn()
      .mockResolvedValueOnce({
        decisions: [
          { id: "d1", intent: "i", status: "active", classifiedAt: 1, matchedFiles: ["src/f0.ts"] },
        ],
        truncated: false,
      })
      .mockResolvedValueOnce({
        decisions: [
          {
            id: "d1",
            intent: "i",
            status: "active",
            classifiedAt: 1,
            matchedFiles: ["src/f26.ts"],
          },
        ],
        truncated: false,
      });
    const result = await checkAffectedDecisions(files, { getClient: () => clientWith(get) });
    expect(get).toHaveBeenCalledTimes(2);
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].matchedFiles).toEqual(["src/f0.ts", "src/f26.ts"]);
  });

  it("surfaces the server's unavailable (org-unbound) instead of a silent clear", async () => {
    const get = vi.fn().mockResolvedValue({
      decisions: [],
      truncated: false,
      unavailable: "no organization bound to this token",
    });
    const result = await checkAffectedDecisions(["src/a.ts"], { getClient: () => clientWith(get) });
    expect(result.unavailable).toBe("no organization bound to this token");
  });

  it("propagates truncated when the server clips the result", async () => {
    const get = vi.fn().mockResolvedValue({ decisions: [], truncated: true });
    const result = await checkAffectedDecisions(["src/a.ts"], { getClient: () => clientWith(get) });
    expect(result.truncated).toBe(true);
  });

  it("reports UNKNOWN (not a silent all-clear) on a transport/auth failure", async () => {
    const get = vi.fn().mockRejectedValue(new Error("network down"));
    const result = await checkAffectedDecisions(["src/a.ts"], { getClient: () => clientWith(get) });
    expect(result.decisions).toEqual([]);
    expect(result.unavailable).toContain("network down");
  });
});

describe("formatDecisionsWarning", () => {
  it("returns an empty string for a verified-clear result (stays silent)", () => {
    expect(formatDecisionsWarning({ decisions: [], truncated: false })).toBe("");
  });

  it("includes intent, file list, and rationale per decision", () => {
    const warning = formatDecisionsWarning({
      decisions: [
        {
          id: "d1",
          intent: "Use Redis for caching",
          rationale: "Latency budget is 5ms p95",
          status: "active",
          classifiedAt: 1,
          matchedFiles: ["src/redis.ts"],
        },
      ],
      truncated: false,
    });
    expect(warning).toContain("Use Redis for caching");
    expect(warning).toContain("files: src/redis.ts");
    expect(warning).toContain("rationale: Latency budget is 5ms p95");
  });

  it("marks under_review and omits the rationale line when absent", () => {
    const warning = formatDecisionsWarning({
      decisions: [
        {
          id: "d2",
          intent: "Use Postgres row-level security",
          status: "under_review",
          classifiedAt: 1,
          matchedFiles: ["src/db.ts"],
        },
      ],
      truncated: false,
    });
    expect(warning).toContain("(under review)");
    expect(warning).not.toContain("rationale:");
  });

  it("truncates matched files past the preview limit", () => {
    const warning = formatDecisionsWarning({
      decisions: [
        {
          id: "d3",
          intent: "Modular auth layer",
          status: "active",
          classifiedAt: 1,
          matchedFiles: ["a", "b", "c", "d", "e"],
        },
      ],
      truncated: false,
    });
    expect(warning).toContain("(+2 more)");
  });

  it("surfaces an UNKNOWN banner when unavailable, even with zero decisions", () => {
    const warning = formatDecisionsWarning({
      decisions: [],
      truncated: false,
      unavailable: "no organization bound to this token",
    });
    expect(warning).toContain("not verified");
    expect(warning).toContain("no organization bound to this token");
  });

  it("surfaces a truncation banner", () => {
    expect(formatDecisionsWarning({ decisions: [], truncated: true })).toContain("truncated");
  });
});
