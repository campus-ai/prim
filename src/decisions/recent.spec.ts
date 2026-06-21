/**
 * `prim decisions recent` — formatter + fetch coverage.
 *
 * Two halves:
 *   1. The pure formatters (`formatRecentHuman`, `formatRecentJson`) and the
 *      `renderIdentifier` helper.
 *   2. The `fetchRecent` error/unknown contract — the org-unbound 200 and the
 *      thrown-error path must surface as UNKNOWN (`unavailable`), never as a
 *      clean empty feed. (Previously these paths were unexercised — F5.)
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";

const { mockDaemonRequest } = vi.hoisted(() => ({
  mockDaemonRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock("../daemon/client.js", () => ({
  daemonRequest: mockDaemonRequest,
}));

import {
  type DecisionFeedRow,
  type RecentDeps,
  fetchRecent,
  formatRecentHuman,
  formatRecentJson,
  renderIdentifier,
} from "./recent.js";

const SELF_ROW: DecisionFeedRow = {
  id: "qx7fpmycwabtzke040y7vecnnh8870pg",
  shortId: "230a72aa",
  intent: "Update the AUTH_PROVIDER constant to mark WorkOS as verified",
  rationale: "Verification flow",
  area: "auth",
  producerKind: "claude_code",
  userId: "u_taylor",
  authorName: "Taylor",
  authorIsSelf: true,
  classifiedAt: Date.UTC(2026, 5, 7, 19, 9, 37),
  status: "active",
};

const TEAMMATE_ROW: DecisionFeedRow = {
  id: "qx70t5ks31z4gbf303ze3v0nb58878wz",
  shortId: "18294ea6",
  intent: "Pick a TTL",
  rationale: undefined,
  area: "billing",
  producerKind: "chat",
  userId: "u_maya",
  authorName: "Maya",
  authorIsSelf: false,
  classifiedAt: Date.UTC(2026, 5, 7, 19, 8, 64),
  status: "active",
};

/** A `CliClient` whose `get` is the supplied stub; other verbs throw. */
function clientWith(get: CliClient["get"]): CliClient {
  const unexpected = () => {
    throw new Error("unexpected non-GET call");
  };
  return {
    get,
    post: unexpected,
  };
}

function depsReturning(payload: unknown): RecentDeps {
  const client = clientWith(vi.fn().mockResolvedValue(payload));
  return { getClient: () => client };
}

function depsThrowing(err: unknown): RecentDeps {
  const client = clientWith(vi.fn().mockRejectedValue(err));
  return { getClient: () => client };
}

describe("fetchRecent", () => {
  beforeEach(() => {
    mockDaemonRequest.mockReset();
    mockDaemonRequest.mockResolvedValue(null);
  });

  it("uses the daemon recent proxy when available", async () => {
    mockDaemonRequest.mockResolvedValueOnce({ decisions: [SELF_ROW] });
    const get = vi.fn().mockResolvedValue({ decisions: [] });

    const result = await fetchRecent(
      { limit: 5, since: "30m" },
      { getClient: () => clientWith(get) },
    );

    expect(result.decisions).toEqual([SELF_ROW]);
    expect(mockDaemonRequest).toHaveBeenCalledWith(
      "decisions_recent",
      { path: "/api/cli/decisions/recent?limit=5&since=30m" },
      { timeoutMs: 250 },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("maps a healthy feed straight through with no unavailable reason", async () => {
    const result = await fetchRecent({}, depsReturning({ decisions: [SELF_ROW] }));
    expect(result.decisions).toHaveLength(1);
    expect(result.decisions[0].shortId).toBe(SELF_ROW.shortId);
    expect(result.unavailable).toBeUndefined();
  });

  it("forwards limit and since as query params", async () => {
    const get = vi.fn().mockResolvedValue({ decisions: [] });
    const deps: RecentDeps = { getClient: () => clientWith(get) };
    await fetchRecent({ limit: 5, since: "30m" }, deps);
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("limit=5");
    expect(url).toContain("since=30m");
  });

  it("reads the server's unavailable reason on an org-unbound 200", async () => {
    // Org-unbound token: server returns HTTP 200 with an empty feed plus a
    // reason. That reason must flow through, not be dropped as a clean feed.
    const result = await fetchRecent(
      {},
      depsReturning({
        decisions: [],
        unavailable: "no organization bound to this token",
      }),
    );
    expect(result.decisions).toHaveLength(0);
    expect(result.unavailable).toBe("no organization bound to this token");
  });

  it("records the error reason when the request throws (expired token / down API / bad --since)", async () => {
    const result = await fetchRecent(
      {},
      depsThrowing(new Error("Authentication expired. Run `prim auth login` to re-authenticate.")),
    );
    expect(result.decisions).toEqual([]);
    expect(result.unavailable).toBe(
      "recent feed failed: Authentication expired. Run `prim auth login` to re-authenticate.",
    );
  });

  it("stringifies a non-Error throw rather than masking it", async () => {
    const result = await fetchRecent({}, depsThrowing("boom"));
    expect(result.unavailable).toBe("recent feed failed: boom");
  });
});

describe("formatRecentHuman", () => {
  it("returns the empty-feed verdict when there are no decisions", () => {
    expect(formatRecentHuman({ decisions: [] })).toBe("[prim] recent · 0 decisions");
  });

  it("surfaces a not-verified line instead of 0 decisions when unavailable is set", () => {
    const out = formatRecentHuman({
      decisions: [],
      unavailable: "no organization bound to this token",
    });
    expect(out).toBe("[prim] recent · feed not verified — no organization bound to this token");
    expect(out).not.toContain("0 decisions");
  });

  it("renders Your Claude Code for a self row with claude_code producer", () => {
    const out = formatRecentHuman({ decisions: [SELF_ROW] });
    expect(out).toContain("Your Claude Code");
    expect(out).toContain("• auth");
    expect(out).toContain(SELF_ROW.intent);
  });

  it("renders the human display name for a teammate row", () => {
    const out = formatRecentHuman({ decisions: [TEAMMATE_ROW] });
    expect(out).toContain("Maya");
    expect(out).not.toContain("Your");
    expect(out).toContain("• billing");
  });

  it("renders a hyphen-ish placeholder when area is undefined", () => {
    const out = formatRecentHuman({
      decisions: [{ ...SELF_ROW, area: undefined }],
    });
    expect(out).toContain("•  ");
  });
});

describe("formatRecentJson", () => {
  it("emits stable JSON with the decisions array", () => {
    const out = formatRecentJson({ decisions: [SELF_ROW] });
    const parsed = JSON.parse(out);
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.decisions[0].shortId).toBe(SELF_ROW.shortId);
  });

  it("emits an empty decisions array verbatim", () => {
    const out = formatRecentJson({ decisions: [] });
    expect(JSON.parse(out)).toEqual({ decisions: [] });
  });

  it("carries the unavailable reason through to STDOUT JSON", () => {
    const out = formatRecentJson({
      decisions: [],
      unavailable: "no organization bound to this token",
    });
    expect(JSON.parse(out)).toEqual({
      decisions: [],
      unavailable: "no organization bound to this token",
    });
  });
});

describe("renderIdentifier", () => {
  it("prefixes shortId with dec_", () => {
    expect(renderIdentifier({ shortId: "8c2f1a07", id: "x" })).toBe("dec_8c2f1a07");
  });

  it("falls back to the raw id when shortId is undefined", () => {
    expect(renderIdentifier({ shortId: undefined, id: "qx7fpmyc" })).toBe("qx7fpmyc");
  });
});
