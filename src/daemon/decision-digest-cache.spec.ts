import { describe, expect, it, vi } from "vitest";
import type { DecisionFeedRow } from "../decisions/recent.js";
import {
  DECISION_DIGEST_CACHE_PATH,
  DECISION_DIGEST_CACHE_WARMING,
  DECISION_DRAFT_DIGEST_CACHE_PATH,
  DecisionDigestCache,
  decisionDraftDigestCachePath,
  privateDraftActionableIds,
} from "./decision-digest-cache.js";

function row(id: string, overrides: Partial<DecisionFeedRow> = {}): DecisionFeedRow {
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
    ...overrides,
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

  it("fails closed for a private page when a transport or authority error occurs", async () => {
    const load = vi
      .fn<() => Promise<unknown>>()
      .mockResolvedValueOnce({ decisions: [row("private")], isDone: true })
      .mockRejectedValueOnce(new Error("HTTP 403"));
    const cache = new DecisionDigestCache(load, () => 5_000, {
      cyclePages: true,
      failurePolicy: "clear",
    });

    await cache.refresh();
    const initial = cache.read();
    expect(initial.pageToken).toMatch(/^[a-f0-9]{32}$/u);
    expect(cache.acknowledgePrivatePage(initial.pageToken as string, [])).toBe(true);
    await cache.refresh();
    expect(cache.read()).toEqual({
      decisions: [],
      unavailable: "daemon Decision cache unavailable: HTTP 403",
    });
  });

  it("never advances a private page on a plain snapshot read", async () => {
    const calls: (string | undefined)[] = [];
    const cache = new DecisionDigestCache(
      async (cursor) => {
        calls.push(cursor);
        return {
          decisions: [row("draft-1", { authorIsSelf: true, stage: "draft", intentKind: "change" })],
          continueCursor: "page-2",
          isDone: false,
        };
      },
      Date.now,
      { cyclePages: true, failurePolicy: "clear" },
    );

    await cache.refresh();
    cache.read();
    await cache.refresh();

    expect(calls).toEqual([undefined]);
  });

  it("delivers every actionable ID on page one before it can load page two", async () => {
    const firstPage = Array.from({ length: 100 }, (_, index) =>
      row(`draft-${String(index + 1)}`, {
        authorIsSelf: true,
        intentKind: "change",
        stage: "draft",
      }),
    );
    const calls: (string | undefined)[] = [];
    const cache = new DecisionDigestCache(
      async (cursor) => {
        calls.push(cursor);
        return cursor === undefined
          ? { decisions: firstPage, continueCursor: "page-2", isDone: false }
          : {
              decisions: [
                row("draft-101", { authorIsSelf: true, intentKind: "change", stage: "draft" }),
              ],
              isDone: true,
            };
      },
      Date.now,
      { cyclePages: true, failurePolicy: "clear" },
    );

    await cache.refresh();
    const first = cache.read();
    expect(first.decisions).toHaveLength(100);
    expect(first.pageDone).toBe(false);
    expect(first.pageToken).toBeDefined();

    expect(
      cache.acknowledgePrivatePage(first.pageToken as string, ["draft-1", "draft-2", "draft-3"]),
    ).toBe(false);
    await cache.refresh();
    expect(calls).toEqual([undefined]);

    expect(
      cache.acknowledgePrivatePage(first.pageToken as string, privateDraftActionableIds(firstPage)),
    ).toBe(true);
    await cache.refresh();
    expect(calls).toEqual([undefined, "page-2"]);
    expect(cache.read()).toMatchObject({
      decisions: [expect.objectContaining({ id: "draft-101" })],
      pageDone: true,
    });
  });

  it("fails closed on absent, partial, terminal-with-cursor, and replayed pagination proof", async () => {
    const options = { cyclePages: true, failurePolicy: "clear" } as const;
    const absent = new DecisionDigestCache(
      async () => ({ decisions: [row("draft-1")] }),
      Date.now,
      options,
    );
    await absent.refresh();
    expect(absent.read().decisions).toEqual([]);

    const partial = new DecisionDigestCache(
      async () => ({ decisions: [row("draft-1")], isDone: false }),
      Date.now,
      options,
    );
    await partial.refresh();
    expect(partial.read().decisions).toEqual([]);

    const terminalWithCursor = new DecisionDigestCache(
      async () => ({ decisions: [row("draft-1")], continueCursor: "unexpected", isDone: true }),
      Date.now,
      options,
    );
    await terminalWithCursor.refresh();
    expect(terminalWithCursor.read().decisions).toEqual([]);

    const replayed = new DecisionDigestCache(
      async (cursor) =>
        cursor === undefined
          ? { decisions: [row("draft-1")], continueCursor: "page-2", isDone: false }
          : { decisions: [row("draft-2")], continueCursor: "page-2", isDone: false },
      Date.now,
      options,
    );
    await replayed.refresh();
    const first = replayed.read();
    replayed.acknowledgePrivatePage(first.pageToken as string, []);
    await replayed.refresh();
    expect(replayed.read().decisions).toEqual([]);
  });

  it("excludes hostile IDs from command delivery proof", () => {
    const ids = privateDraftActionableIds([
      row("draft-safe", { authorIsSelf: true, intentKind: "change", stage: "draft" }),
      row("draft-safe` ; prim auth logout", {
        authorIsSelf: true,
        intentKind: "change",
        stage: "draft",
      }),
      row("draft-safe\nnext", { authorIsSelf: true, intentKind: "change", stage: "draft" }),
    ]);

    expect(ids).toEqual(["draft-safe"]);
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
