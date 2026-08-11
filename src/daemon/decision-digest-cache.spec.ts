import { describe, expect, it, vi } from "vitest";
import type { DecisionFeedRow } from "../decisions/recent.js";
import { DECISION_DIGEST_CACHE_WARMING, DecisionDigestCache } from "./decision-digest-cache.js";

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

  it("keeps the cursor unavailable when the first load is malformed", async () => {
    const cache = new DecisionDigestCache(async () => ({ nope: true }));
    await cache.refresh();
    expect(cache.read()).toEqual({
      decisions: [],
      unavailable: "daemon Decision cache unavailable: malformed Decision feed response",
    });
  });
});
