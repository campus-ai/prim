import { describe, expect, it } from "vitest";
import {
  deliveryBacklogState,
  deliveryBacklogSummary,
  formatPendingBacklog,
} from "./delivery-backlog.js";

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const healthyIngestion = {
  healthy: true,
  consecutiveFailures: 0,
  pendingCount: 0,
  pendingSampled: false,
  strandedCount: 0,
  lastAcknowledgedCount: 0,
};
// The PRI-68 shape: weeks of Moves queued while auth was dead, so the daemon's
// own ingestion health is red the moment it comes back.
const backlogIngestion = {
  ...healthyIngestion,
  healthy: false,
  pendingCount: 1200,
  pendingSampled: true,
  oldestPendingAt: NOW - 52 * DAY_MS - 1_000,
};

describe("deliveryBacklogState", () => {
  it("is absent while ingestion meets its SLA or is unreported", () => {
    expect(deliveryBacklogState(healthyIngestion)).toBeUndefined();
    expect(deliveryBacklogState(undefined)).toBeUndefined();
    expect(deliveryBacklogState({})).toBeUndefined();
  });

  it("drains only while the daemon has recorded no delivery failure", () => {
    expect(deliveryBacklogState(backlogIngestion)).toBe("draining");
    expect(deliveryBacklogState({ ...backlogIngestion, consecutiveFailures: 1 })).toBe("failing");
  });

  it("drains when the failed sweep acknowledged Moves before it failed", () => {
    expect(
      deliveryBacklogState({
        ...backlogIngestion,
        consecutiveFailures: 2,
        lastAcknowledgedCount: 500,
      }),
    ).toBe("draining");
    // Progress is only credited next to a well-formed failure count.
    expect(deliveryBacklogState({ healthy: false, lastAcknowledgedCount: 500 })).toBe("failing");
  });

  it("is retained, never draining, while the last sweep held buckets back", () => {
    const retained = { ...backlogIngestion, lastRetainedBucketCount: 1 };
    expect(deliveryBacklogState(retained)).toBe("retained");
    expect(deliveryBacklogState({ ...retained, lastAcknowledgedCount: 500 })).toBe("retained");
    expect(
      deliveryBacklogState({ ...retained, consecutiveFailures: 1, lastAcknowledgedCount: 500 }),
    ).toBe("retained");
    // A failure without progress names the failure instead.
    expect(deliveryBacklogState({ ...retained, consecutiveFailures: 1 })).toBe("failing");
    expect(deliveryBacklogState({ ...retained, lastRetainedBucketCount: 0 })).toBe("draining");
  });

  it("reads a missing or malformed failure count as failing, never as progress", () => {
    expect(deliveryBacklogState({ healthy: false })).toBe("failing");
    expect(deliveryBacklogState({ healthy: false, consecutiveFailures: Number.NaN })).toBe(
      "failing",
    );
  });
});

describe("deliveryBacklogSummary", () => {
  it("renders a sampled backlog as a lower bound with a coarse age", () => {
    expect(deliveryBacklogSummary(backlogIngestion, NOW)).toBe(
      "draining at least 1200 pending moves (oldest ≥ 52d) in the background",
    );
  });

  it("ignores a resolved error while draining", () => {
    expect(deliveryBacklogSummary({ ...backlogIngestion, lastError: "stale, resolved" }, NOW)).toBe(
      "draining at least 1200 pending moves (oldest ≥ 52d) in the background",
    );
  });

  it("names held-back buckets and their reasons instead of draining", () => {
    expect(
      deliveryBacklogSummary(
        {
          ...backlogIngestion,
          lastRetainedBucketCount: 2,
          lastRetainedReasons: "organization_mismatch:1, unbound:1",
        },
        NOW,
      ),
    ).toBe(
      "delivery held back: 2 organization buckets retained (organization_mismatch:1, unbound:1) · holding at least 1200 pending moves (oldest ≥ 52d) — run `prim doctor`",
    );
    expect(
      deliveryBacklogSummary(
        { ...backlogIngestion, pendingSampled: false, lastRetainedBucketCount: 1 },
        NOW,
      ),
    ).toBe(
      "delivery held back: 1 organization bucket retained · holding 1200 pending moves (oldest 52d) — run `prim doctor`",
    );
  });

  it("names recorded failures and the bounded last error instead of draining", () => {
    expect(
      deliveryBacklogSummary(
        { ...backlogIngestion, consecutiveFailures: 3, lastError: "HTTP 504\n  gateway timeout" },
        NOW,
      ),
    ).toBe(
      "delivery failing (3 consecutive failures): HTTP 504 gateway timeout · retrying at least 1200 pending moves (oldest ≥ 52d) in the background",
    );
    expect(deliveryBacklogSummary({ ...backlogIngestion, consecutiveFailures: 1 }, NOW)).toBe(
      "delivery failing (1 consecutive failure) · retrying at least 1200 pending moves (oldest ≥ 52d) in the background",
    );
    expect(deliveryBacklogSummary({ healthy: false }, NOW)).toBe(
      "delivery failing · retrying an unknown number of pending moves in the background",
    );
  });

  it("prefers a fresher journal scan for the counts, but not for the state", () => {
    const live = { pendingCount: 40, pendingSampled: false, oldestPendingAt: NOW - 3_600_000 };
    expect(deliveryBacklogSummary(backlogIngestion, NOW, live)).toBe(
      "draining 40 pending moves (oldest 1h) in the background",
    );
    expect(deliveryBacklogSummary(healthyIngestion, NOW, live)).toBeUndefined();
  });

  it("is absent for healthy or missing ingestion", () => {
    expect(deliveryBacklogSummary(healthyIngestion, NOW)).toBeUndefined();
    expect(deliveryBacklogSummary(undefined, NOW)).toBeUndefined();
  });
});

describe("formatPendingBacklog", () => {
  it("formats exact, singular, unknown, and sub-day backlogs", () => {
    expect(
      formatPendingBacklog(
        { pendingCount: 1, pendingSampled: false, oldestPendingAt: NOW - 3 * 3_600_000 },
        NOW,
      ),
    ).toBe("1 pending move (oldest 3h)");
    expect(
      formatPendingBacklog(
        { pendingCount: 12, pendingSampled: false, oldestPendingAt: NOW - 125_000 },
        NOW,
      ),
    ).toBe("12 pending moves (oldest 2m)");
    expect(
      formatPendingBacklog(
        { pendingCount: 2, pendingSampled: false, oldestPendingAt: NOW + 5 },
        NOW,
      ),
    ).toBe("2 pending moves (oldest 0s)");
    expect(formatPendingBacklog({ pendingCount: 0, pendingSampled: true }, NOW)).toBe(
      "an unknown number of pending moves",
    );
    expect(formatPendingBacklog({}, NOW)).toBe("an unknown number of pending moves");
  });

  it("bounds a sampled age from below, since unread files can hold older Moves", () => {
    expect(
      formatPendingBacklog(
        { pendingCount: 3, pendingSampled: true, oldestPendingAt: NOW - 3 * 3_600_000 },
        NOW,
      ),
    ).toBe("at least 3 pending moves (oldest ≥ 3h)");
    expect(
      formatPendingBacklog(
        { pendingCount: 0, pendingSampled: true, oldestPendingAt: NOW - 125_000 },
        NOW,
      ),
    ).toBe("an unknown number of pending moves (oldest ≥ 2m)");
  });
});
