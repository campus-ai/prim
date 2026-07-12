import { describe, expect, it, vi } from "vitest";
import {
  type FeedbackLease,
  MAX_FEEDBACK_INTENT_CODE_POINTS,
  acknowledgeDecisionFeedback,
  leaseDecisionFeedback,
  normalizeFeedbackIntent,
  parseFeedbackCapability,
  parseFeedbackLease,
  renderFeedback,
} from "./feedback.js";

const signal = AbortSignal.timeout(5_000);

function event(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventId: "event-1",
    leaseVersion: 1,
    shortId: "a1b2c3d4",
    intent: "Use the stable API",
    ...overrides,
  };
}

describe("normalizeFeedbackIntent", () => {
  it("collapses whitespace and removes controls and bidi overrides", () => {
    expect(normalizeFeedbackIntent("  use\n\t the\u0000 safe\u202e API  ")).toBe(
      "use the safe API",
    );
  });

  it("preserves valid Unicode and replaces isolated surrogates", () => {
    expect(normalizeFeedbackIntent("Ship 🚀 café \ud800 now")).toBe("Ship 🚀 café � now");
  });

  it("truncates by code point with an ellipsis", () => {
    const normalized = normalizeFeedbackIntent("🚀".repeat(300));
    expect(Array.from(normalized)).toHaveLength(MAX_FEEDBACK_INTENT_CODE_POINTS);
    expect(normalized.endsWith("…")).toBe(true);
  });
});

describe("parseFeedbackLease", () => {
  it("accepts the versioned leased, empty, and unavailable responses", () => {
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event()],
        hasMore: true,
        additiveFutureField: true,
      }),
    ).toEqual({
      events: [
        {
          eventId: "event-1",
          leaseVersion: 1,
          shortId: "a1b2c3d4",
          intent: "Use the stable API",
        },
      ],
      hasMore: true,
    });
    expect(parseFeedbackLease({ protocolVersion: 1, status: "empty", hasMore: false })).toEqual({
      events: [],
      hasMore: false,
    });
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "unavailable",
        reason: "organization_unbound",
      }),
    ).toEqual({ events: [], hasMore: false });
  });

  it("rejects unknown versions/statuses and malformed event tokens", () => {
    expect(
      parseFeedbackLease({ protocolVersion: 2, status: "empty", hasMore: false }),
    ).toBeUndefined();
    expect(parseFeedbackLease({ protocolVersion: 1, status: "future" })).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event({ leaseVersion: 0 })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event({ eventId: "event\u202e-1" })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event({ shortId: "ABC12345" })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event(), event()],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event({ intent: "x".repeat(513) })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event({ shortId: "x\nspoof" })],
        hasMore: false,
      }),
    ).toBeUndefined();
  });
});

describe("renderFeedback", () => {
  it("renders the exact copy and retains only the corresponding ack token", () => {
    const lease = parseFeedbackLease({
      protocolVersion: 1,
      status: "leased",
      events: [event()],
      hasMore: false,
    });
    expect(renderFeedback(lease as FeedbackLease)).toEqual({
      systemMessage: "[prim] response → created Decision (dec_a1b2c3d4): Use the stable API",
      deliveries: [{ eventId: "event-1", leaseVersion: 1 }],
    });
  });

  it("stops before the 8k display budget and leaves overflow unacknowledged", () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      eventId: `event-${String(index)}`,
      leaseVersion: 1,
      shortId: `id${String(index)}`,
      intent: "x".repeat(MAX_FEEDBACK_INTENT_CODE_POINTS),
    }));
    const rendered = renderFeedback({ events, hasMore: false });
    expect(rendered).toBeDefined();
    expect(Array.from(rendered?.systemMessage ?? "").length).toBeLessThanOrEqual(8_000);
    expect(rendered?.deliveries.length).toBeLessThan(events.length);
  });
});

describe("feedback HTTP client", () => {
  it("leases directly with the closed request and quiet shared signal", async () => {
    const post = vi.fn().mockResolvedValue({ protocolVersion: 1, status: "empty", hasMore: false });
    const result = await leaseDecisionFeedback(
      { workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4", currentSessionId: "s1", signal },
      { client: { get: vi.fn(), post } },
    );
    expect(result).toEqual({ events: [], hasMore: false });
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/feedback/lease",
      {
        protocolVersion: 1,
        workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
        currentSessionId: "s1",
      },
      { signal, quietRefresh: true },
    );
  });

  it("fails soft on an old server and sends fenced acknowledgments", async () => {
    const oldServer = vi.fn().mockRejectedValue(new Error("HTTP 404"));
    await expect(
      leaseDecisionFeedback(
        { workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4", currentSessionId: "s1", signal },
        { client: { get: vi.fn(), post: oldServer } },
      ),
    ).resolves.toBeUndefined();

    const post = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      status: "acked",
      acknowledgedEventIds: ["event-1"],
    });
    await expect(
      acknowledgeDecisionFeedback(
        {
          workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
          deliveries: [{ eventId: "event-1", leaseVersion: 3 }],
          signal,
        },
        { client: { get: vi.fn(), post } },
      ),
    ).resolves.toBe(true);
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/feedback/ack",
      {
        protocolVersion: 1,
        workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
        deliveries: [{ eventId: "event-1", leaseVersion: 3 }],
      },
      { signal, quietRefresh: true },
    );
  });

  it("surfaces malformed successful responses only through the debug callback", async () => {
    const onError = vi.fn();
    const post = vi.fn().mockResolvedValue({ protocolVersion: 99, status: "empty" });
    await expect(
      leaseDecisionFeedback(
        {
          workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
          currentSessionId: "s1",
          signal,
        },
        { client: { get: vi.fn(), post }, onError },
      ),
    ).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledOnce();
  });
});

describe("parseFeedbackCapability", () => {
  it("accepts only the versioned capability union", () => {
    expect(parseFeedbackCapability({ protocolVersion: 1, status: "available" })).toEqual({
      status: "available",
    });
    expect(
      parseFeedbackCapability({
        protocolVersion: 1,
        status: "unavailable",
        reason: "organization_unbound",
      }),
    ).toEqual({ status: "unavailable", reason: "organization_unbound" });
    expect(parseFeedbackCapability({ protocolVersion: 1, status: "unknown" })).toBeUndefined();
  });
});
