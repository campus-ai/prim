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
  formatRecentRow,
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
      expect.objectContaining({ path: "/api/cli/decisions/recent?limit=5&since=30m" }),
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

  it("reads the server's viewerHasDecisions flag through when present", async () => {
    const has = await fetchRecent(
      {},
      depsReturning({ decisions: [SELF_ROW], viewerHasDecisions: true }),
    );
    expect(has.viewerHasDecisions).toBe(true);
    const hasnt = await fetchRecent(
      {},
      depsReturning({ decisions: [], viewerHasDecisions: false }),
    );
    expect(hasnt.viewerHasDecisions).toBe(false);
  });

  it("leaves viewerHasDecisions undefined on a pre-flag backend", async () => {
    const result = await fetchRecent({}, depsReturning({ decisions: [SELF_ROW] }));
    expect(result.viewerHasDecisions).toBeUndefined();
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

  it("rejects an empty --author locally, before any transport", async () => {
    // An old backend would ignore the empty param and return the org
    // feed without an echo — the skew guard would then misreport a
    // usage error as a backend-version problem. Fail it at home.
    const get = vi.fn();
    const result = await fetchRecent({ author: "   " }, { getClient: () => clientWith(get) });
    expect(result).toEqual({
      decisions: [],
      unavailable: "--author must be a non-empty name",
    });
    expect(get).not.toHaveBeenCalled();
    expect(mockDaemonRequest).not.toHaveBeenCalled();
  });

  it("forwards author as a URL-encoded query param", async () => {
    const get = vi.fn().mockResolvedValue({
      decisions: [],
      author: { userId: "u_ian", name: "Ian" },
      authorHasDecisions: false,
    });
    await fetchRecent({ author: "Ian Chen" }, { getClient: () => clientWith(get) });
    const url = get.mock.calls[0][0] as string;
    expect(url).toContain("author=Ian+Chen");
  });

  it("reads the author echo and authorHasDecisions through on a filtered feed", async () => {
    const result = await fetchRecent(
      { author: "ian" },
      depsReturning({
        decisions: [TEAMMATE_ROW],
        viewerHasDecisions: true,
        author: { userId: "u_maya", name: "Maya" },
        authorHasDecisions: true,
      }),
    );
    expect(result.author).toEqual({ userId: "u_maya", name: "Maya" });
    expect(result.authorHasDecisions).toBe(true);
    expect(result.viewerHasDecisions).toBe(true);
    expect(result.unavailable).toBeUndefined();
  });

  it("skew guard also covers the daemon proxy path (old daemon-side backend)", async () => {
    // The daemon forwards the path verbatim, so the author param rides
    // through — but the BACKEND behind it may still predate the filter.
    // An echo-less daemon payload must trip the same guard.
    mockDaemonRequest.mockResolvedValueOnce({
      decisions: [SELF_ROW],
      viewerHasDecisions: true,
    });
    const get = vi.fn().mockResolvedValue({ decisions: [] });
    const result = await fetchRecent({ author: "Ian" }, { getClient: () => clientWith(get) });
    expect(result.decisions).toEqual([]);
    expect(result.unavailable).toContain("--author requires a newer Primitive backend");
    expect(mockDaemonRequest).toHaveBeenCalledWith(
      "decisions_recent",
      expect.objectContaining({
        path: "/api/cli/decisions/recent?author=Ian",
      }),
      { timeoutMs: 250 },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("passes an author-echoing daemon payload through untouched", async () => {
    mockDaemonRequest.mockResolvedValueOnce({
      decisions: [TEAMMATE_ROW],
      viewerHasDecisions: true,
      author: { userId: "u_maya", name: "Maya" },
      authorHasDecisions: true,
    });
    const result = await fetchRecent({ author: "Maya" }, { getClient: () => clientWith(vi.fn()) });
    expect(result.decisions).toEqual([TEAMMATE_ROW]);
    expect(result.author).toEqual({ userId: "u_maya", name: "Maya" });
    expect(result.unavailable).toBeUndefined();
  });

  it("never presents an echo-less feed as the author's (pre-author backend skew)", async () => {
    // An old backend ignores the unknown param and returns the UNFILTERED
    // team feed — rows that are NOT the asked-for author's. The guard must
    // drop them and surface UNKNOWN.
    const result = await fetchRecent(
      { author: "Ian" },
      depsReturning({ decisions: [SELF_ROW, TEAMMATE_ROW], viewerHasDecisions: true }),
    );
    expect(result.decisions).toEqual([]);
    expect(result.unavailable).toBe(
      "--author requires a newer Primitive backend (no author echo in response); retry without --author for the team-wide feed",
    );
  });

  it("skew guard defers to a server-sent unavailable (unknown/ambiguous author)", async () => {
    const result = await fetchRecent(
      { author: "nobody" },
      depsReturning({
        decisions: [],
        unavailable: 'author "nobody" does not match any member of this organization',
      }),
    );
    expect(result.unavailable).toBe(
      'author "nobody" does not match any member of this organization',
    );
  });

  it("skew guard never fires without an author arg", async () => {
    const result = await fetchRecent({}, depsReturning({ decisions: [SELF_ROW] }));
    expect(result.decisions).toEqual([SELF_ROW]);
    expect(result.unavailable).toBeUndefined();
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

  it("labels an author-filtered feed with the resolved name", () => {
    const out = formatRecentHuman({
      decisions: [TEAMMATE_ROW],
      author: { userId: "u_maya", name: "Maya" },
      authorHasDecisions: true,
    });
    expect(out).toContain("[prim] recent · Maya · 1 decision(s)");
    expect(out).toContain(formatRecentRow(TEAMMATE_ROW));
  });

  it("says older decisions exist on an empty author page with authorHasDecisions", () => {
    const out = formatRecentHuman({
      decisions: [],
      author: { userId: "u_ian", name: "Ian" },
      authorHasDecisions: true,
    });
    expect(out).toBe(
      "[prim] recent · Ian · 0 decisions in this window (older decisions exist — widen --since or raise --limit)",
    );
  });

  it("says no feed-visible decisions on an empty author page with authorHasDecisions false", () => {
    // "feed-visible", not "never captured": the server counts only
    // status-stamped rows, so the claim must not overreach the truth
    // the backend actually computes.
    const out = formatRecentHuman({
      decisions: [],
      author: { userId: "u_ian", name: "Ian" },
      authorHasDecisions: false,
    });
    expect(out).toBe(
      "[prim] recent · Ian · no feed-visible decisions yet (if unexpected, check prim setup/doctor on their machine and the repo they work in)",
    );
  });

  it("stays neutral when authorHasDecisions is absent — never claims never-captured without evidence", () => {
    const out = formatRecentHuman({
      decisions: [],
      author: { userId: "u_ian", name: "Ian" },
    });
    expect(out).toBe("[prim] recent · Ian · 0 decisions");
  });

  it("unavailable still beats an author echo", () => {
    const out = formatRecentHuman({
      decisions: [],
      author: { userId: "u_ian", name: "Ian" },
      unavailable: "recent feed failed: boom",
    });
    expect(out).toBe("[prim] recent · feed not verified — recent feed failed: boom");
  });
});

describe("formatRecentRow", () => {
  it("composes formatRecentHuman so `prim welcome` reuses byte-identical formatting", () => {
    expect(formatRecentHuman({ decisions: [TEAMMATE_ROW] })).toContain(
      formatRecentRow(TEAMMATE_ROW),
    );
  });

  it("renders the author, area bullet, and intent on a single row", () => {
    const out = formatRecentRow(TEAMMATE_ROW);
    expect(out).toContain("Maya");
    expect(out).toContain("• billing");
    expect(out).toContain(TEAMMATE_ROW.intent);
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

  it("carries the author echo and authorHasDecisions through to STDOUT JSON", () => {
    const out = formatRecentJson({
      decisions: [],
      author: { userId: "u_ian", name: "Ian" },
      authorHasDecisions: false,
    });
    expect(JSON.parse(out)).toEqual({
      decisions: [],
      author: { userId: "u_ian", name: "Ian" },
      authorHasDecisions: false,
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
