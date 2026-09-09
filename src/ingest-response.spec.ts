import { afterEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ scheduleCollectScopeRefresh: vi.fn() }));

vi.mock("./lib/collect-scope.js", () => ({
  scheduleCollectScopeRefresh: mocks.scheduleCollectScopeRefresh,
}));

import {
  IngestAcknowledgementError,
  requireDurableIngestAcknowledgement,
} from "./ingest-response.js";

afterEach(() => {
  vi.resetAllMocks();
});

describe("requireDurableIngestAcknowledgement", () => {
  it("schedules a cache refresh when a durable acknowledgement carries a valid version", () => {
    expect(
      requireDurableIngestAcknowledgement(
        { disposition: "persisted", acknowledged: 2, collectScopeVersion: 17 },
        2,
        "/repo",
      ),
    ).toMatchObject({ disposition: "persisted", acknowledged: 2 });

    expect(mocks.scheduleCollectScopeRefresh).toHaveBeenCalledWith("/repo", 17);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    "ignores an invalid collection-scope version of %s",
    (collectScopeVersion) => {
      requireDurableIngestAcknowledgement(
        { disposition: "persisted", acknowledged: 1, collectScopeVersion },
        1,
        "/repo",
      );

      expect(mocks.scheduleCollectScopeRefresh).not.toHaveBeenCalled();
    },
  );

  it("keeps rejecting non-durable acknowledgements before attempting a refresh", () => {
    expect(() =>
      requireDurableIngestAcknowledgement(
        { disposition: "persisted", acknowledged: 1, collectScopeVersion: 17 },
        2,
        "/repo",
      ),
    ).toThrow(IngestAcknowledgementError);

    expect(mocks.scheduleCollectScopeRefresh).not.toHaveBeenCalled();
  });

  it("refreshes each clone represented in a durable batch only once", () => {
    requireDurableIngestAcknowledgement(
      { disposition: "persisted", acknowledged: 3, collectScopeVersion: 17 },
      3,
      ["/repo-a", "/repo-b", "/repo-a"],
    );

    expect(mocks.scheduleCollectScopeRefresh).toHaveBeenCalledTimes(2);
    expect(mocks.scheduleCollectScopeRefresh).toHaveBeenCalledWith("/repo-a", 17);
    expect(mocks.scheduleCollectScopeRefresh).toHaveBeenCalledWith("/repo-b", 17);
  });
});
