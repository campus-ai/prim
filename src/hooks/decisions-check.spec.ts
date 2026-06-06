import { describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";
import {
  type DecisionsCheckResult,
  checkAffectedDecisions,
  formatDecisionsWarning,
} from "./decisions-check.js";

function fakeClient(response: DecisionsCheckResult): CliClient {
  return {
    get: vi.fn().mockResolvedValue(response),
    post: vi.fn(),
    patch: vi.fn(),
    delete: vi.fn(),
  } as unknown as CliClient;
}

describe("checkAffectedDecisions", () => {
  it("returns empty result when no files supplied", async () => {
    const client = fakeClient({ decisions: [] });
    const result = await checkAffectedDecisions([], { getClient: () => client });
    expect(result.decisions).toEqual([]);
    expect(client.get).not.toHaveBeenCalled();
  });

  it("calls GET /api/cli/decisions/affecting with comma-joined files", async () => {
    const client = fakeClient({ decisions: [] });
    await checkAffectedDecisions(["src/a.ts", "src/b.ts"], {
      getClient: () => client,
    });
    expect(client.get).toHaveBeenCalledWith(
      expect.stringContaining("/api/cli/decisions/affecting?files=src%2Fa.ts%2Csrc%2Fb.ts"),
      expect.any(Object),
    );
  });

  it("returns empty result on transport failure (warn-only contract)", async () => {
    const client = {
      get: vi.fn().mockRejectedValue(new Error("network down")),
    } as unknown as CliClient;
    const result = await checkAffectedDecisions(["src/a.ts"], {
      getClient: () => client,
    });
    expect(result.decisions).toEqual([]);
  });
});

describe("formatDecisionsWarning", () => {
  it("returns empty string when there are no matches", () => {
    expect(formatDecisionsWarning({ decisions: [] })).toBe("");
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
    });
    expect(warning).toContain("Use Redis for caching");
    expect(warning).toContain("files: src/redis.ts");
    expect(warning).toContain("rationale: Latency budget is 5ms p95");
  });

  it("marks under_review decisions explicitly", () => {
    const warning = formatDecisionsWarning({
      decisions: [
        {
          id: "d2",
          intent: "Use Postgres row-level security",
          rationale: "(no rationale recorded)",
          status: "under_review",
          classifiedAt: 1,
          matchedFiles: ["src/db.ts"],
        },
      ],
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
          rationale: "(no rationale recorded)",
          status: "active",
          classifiedAt: 1,
          matchedFiles: [
            "src/auth/a.ts",
            "src/auth/b.ts",
            "src/auth/c.ts",
            "src/auth/d.ts",
            "src/auth/e.ts",
          ],
        },
      ],
    });
    expect(warning).toContain("(+2 more)");
  });
});
