import { describe, expect, it, vi } from "vitest";
import type { DecisionFeedRow } from "../decisions/recent.js";
import {
  DECISION_DIGEST_CACHE_PATH,
  DECISION_DIGEST_CACHE_WARMING,
  DECISION_DRAFT_DIGEST_CACHE_PATH,
  DecisionDigestCache,
  decisionDraftDigestCachePath,
} from "./decision-digest-cache.js";

function row(id: string): DecisionFeedRow {
  return {
    id,
    shortId: undefined,
    intent: `Decision ${id}`,
    rationale: undefined,
    area: undefined,
    producerKind: "codex",
    userId: `user-${id}`,
    authorName: "Taylor",
    authorIsSelf: false,
    classifiedAt: 1_000,
    status: "active",
  };
}

describe("DecisionDigestCache", () => {
  it("keeps the team and author-private draft feeds on distinct fixed paths", () => {
    expect(DECISION_DIGEST_CACHE_PATH).toBe("/api/cli/decisions/recent?limit=100&since=24h");
    expect(DECISION_DRAFT_DIGEST_CACHE_PATH).toBe(
      "/api/cli/decisions/recent?limit=100&since=24h&drafts=true",
    );
    expect(decisionDraftDigestCachePath("opaque/+ cursor")).toBe(
      "/api/cli/decisions/recent?limit=100&drafts=true&cursor=opaque%2F%2B%20cursor",
    );
  });

  it("starts unavailable and publishes a cloned verified snapshot", async () => {
    const decisions = [row("one")];
    const cache = new DecisionDigestCache(
      async () => ({ decisions }),
      () => 1_234,
    );

    expect(cache.read()).toEqual({
      decisions: [],
      unavailable: DECISION_DIGEST_CACHE_WARMING,
    });
    await cache.refresh();
    const snapshot = cache.read();
    expect(snapshot).toEqual({ decisions, cachedAt: 1_234, unavailable: undefined });

    snapshot.decisions.length = 0;
    expect(cache.read().decisions).toEqual(decisions);
  });

  it("collapses concurrent refreshes onto one server read", async () => {
    let release: ((value: unknown) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new DecisionDigestCache(load);

    const first = cache.refresh();
    const second = cache.refresh();
    expect(load).toHaveBeenCalledOnce();
    release?.({ decisions: [row("one")] });
    await Promise.all([first, second]);
    expect(cache.read().decisions).toHaveLength(1);
  });

  it("retains the last valid page across a transient refresh failure", async () => {
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ decisions: [row("one")] })
      .mockRejectedValueOnce(new Error("offline"));
    const cache = new DecisionDigestCache(load, () => 5_000);

    await cache.refresh();
    await cache.refresh();
    expect(cache.read()).toEqual({
      decisions: [row("one")],
      cachedAt: 5_000,
      unavailable: undefined,
    });
  });

  it("clears a private action page after any authority or transport failure", async () => {
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ decisions: [row("private")] })
      .mockRejectedValueOnce(new Error("HTTP 403"));
    const cache = new DecisionDigestCache(load, () => 5_000, {
      failurePolicy: "clear",
    });

    await cache.refresh();
    expect(cache.read().decisions).toHaveLength(1);
    await cache.refresh();
    expect(cache.read()).toEqual({
      decisions: [],
      unavailable: "daemon Decision cache unavailable: HTTP 403",
    });
  });

  it("cursor-cycles through a 101st private draft instead of starving it", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) => row(`new-${String(index)}`));
    const cursors: (string | undefined)[] = [];
    const cache = new DecisionDigestCache(
      async (cursor) => {
        cursors.push(cursor);
        return cursor === undefined
          ? { decisions: firstPage, continueCursor: "page-2", isDone: false }
          : { decisions: [row("old-101")], continueCursor: "terminal", isDone: true };
      },
      Date.now,
      { cyclePages: true, failurePolicy: "clear" },
    );

    await cache.refresh();
    // The daemon's periodic loop cannot advance a page that no authenticated
    // hook has read yet.
    await cache.refresh();
    expect(cursors).toEqual([undefined]);
    const first = cache.read();
    expect(first.decisions).toHaveLength(100);
    expect(first.pageDone).toBe(false);
    await cache.refresh();
    expect(cache.read()).toMatchObject({
      decisions: [expect.objectContaining({ id: "old-101" })],
      pageDone: true,
    });
    await cache.refresh();
    expect(cache.read().decisions).toHaveLength(100);
    expect(cursors).toEqual([undefined, "page-2", undefined]);
  });

  it("fails closed on partial or replayed pagination evidence", async () => {
    const partial = new DecisionDigestCache(
      async () => ({ decisions: [row("private")], isDone: false }),
      Date.now,
      { cyclePages: true, failurePolicy: "clear" },
    );
    await partial.refresh();
    expect(partial.read().decisions).toEqual([]);

    let calls = 0;
    const replayed = new DecisionDigestCache(
      async () => {
        calls += 1;
        return { decisions: [row("private")], continueCursor: "same", isDone: false };
      },
      Date.now,
      { cyclePages: true, failurePolicy: "clear" },
    );
    await replayed.refresh();
    expect(replayed.read().decisions).toHaveLength(1);
    await replayed.refresh();
    expect(replayed.read().decisions).toEqual([]);
    expect(calls).toBe(2);
  });

  it("keeps the cursor unavailable when the first load is malformed", async () => {
    const cache = new DecisionDigestCache(async () => ({ nope: true }));
    await cache.refresh();
    expect(cache.read()).toEqual({
      decisions: [],
      unavailable: "daemon Decision cache unavailable: malformed Decision feed response",
    });
  });

  it("resets snapshots and fences an old principal's in-flight response", async () => {
    let release: ((value: unknown) => void) | undefined;
    const load = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          release = resolve;
        }),
    );
    const cache = new DecisionDigestCache(load);
    const oldRefresh = cache.refresh();

    cache.reset();
    expect(cache.read()).toEqual({
      decisions: [],
      unavailable: DECISION_DIGEST_CACHE_WARMING,
    });
    release?.({ decisions: [row("old-tenant")] });
    await oldRefresh;

    expect(cache.read()).toEqual({
      decisions: [],
      unavailable: DECISION_DIGEST_CACHE_WARMING,
    });
  });
});
