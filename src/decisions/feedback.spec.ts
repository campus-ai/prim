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
    kind: "confirm_prompt",
    ...overrides,
  };
}

const webUrl = "https://app.getprimitive.ai/decisions/r571n1dqjdrtyxxpf0fnzee4gn8aed6q";

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
        protocolVersion: 2,
        status: "leased",
        events: [event()],
        hasMore: true,
        additiveFutureField: true,
      }),
    ).toEqual({
      protocolVersion: 2,
      events: [
        {
          eventId: "event-1",
          leaseVersion: 1,
          shortId: "a1b2c3d4",
          intent: "Use the stable API",
          kind: "confirm_prompt",
        },
      ],
      hasMore: true,
    });
    expect(parseFeedbackLease({ protocolVersion: 2, status: "empty", hasMore: false })).toEqual({
      protocolVersion: 2,
      events: [],
      hasMore: false,
    });
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "unavailable",
        reason: "organization_unbound",
      }),
    ).toEqual({ protocolVersion: 2, events: [], hasMore: false });
  });

  it("accepts a valid web URL and preserves compatibility when it is missing", () => {
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ webUrl })],
        hasMore: false,
      }),
    ).toEqual({
      protocolVersion: 2,
      events: [
        {
          eventId: "event-1",
          leaseVersion: 1,
          shortId: "a1b2c3d4",
          intent: "Use the stable API",
          webUrl,
          kind: "confirm_prompt",
        },
      ],
      hasMore: false,
    });

    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event()],
        hasMore: false,
      }),
    ).toEqual({
      protocolVersion: 2,
      events: [
        {
          eventId: "event-1",
          leaseVersion: 1,
          shortId: "a1b2c3d4",
          intent: "Use the stable API",
          kind: "confirm_prompt",
        },
      ],
      hasMore: false,
    });
  });

  it.each([
    ["non-string", 42],
    ["empty", ""],
    ["oversized", `https://example.com/${"x".repeat(2_048)}`],
    ["relative", "/decisions/decision-1"],
    ["non-HTTPS", "http://app.getprimitive.ai/decisions/decision-1"],
    ["username", "https://user@app.getprimitive.ai/decisions/decision-1"],
    ["password", "https://user:secret@app.getprimitive.ai/decisions/decision-1"],
    ["whitespace", "https://app.getprimitive.ai/decisions/decision 1"],
    ["C0 control", "https://app.getprimitive.ai/decisions/decision\u0000-1"],
    ["C1 control", "https://app.getprimitive.ai/decisions/decision\u0085-1"],
    ["bidi control", "https://app.getprimitive.ai/decisions/decision\u202e-1"],
    ["isolated high surrogate", "https://app.getprimitive.ai/decisions/decision\ud800-1"],
    ["isolated low surrogate", "https://app.getprimitive.ai/decisions/decision\udfff-1"],
    ["malformed", "https://[invalid"],
  ])("rejects a %s web URL and the whole lease", (_label, invalidWebUrl) => {
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event(), event({ eventId: "event-2", webUrl: invalidWebUrl })],
        hasMore: false,
      }),
    ).toBeUndefined();
  });

  it("defaults v1 events to confirmations but requires an explicit v2 kind", () => {
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event({ kind: undefined })],
        hasMore: false,
      }),
    ).toEqual({
      protocolVersion: 1,
      events: [
        {
          eventId: "event-1",
          leaseVersion: 1,
          shortId: "a1b2c3d4",
          intent: "Use the stable API",
          kind: "confirm_prompt",
        },
      ],
      hasMore: false,
    });
    expect(
      parseFeedbackLease({
        protocolVersion: 1,
        status: "leased",
        events: [event({ kind: "publish_prompt" })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ kind: undefined })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ kind: "future_prompt" })],
        hasMore: false,
      }),
    ).toBeUndefined();
  });

  it("rejects unknown versions/statuses and malformed event tokens", () => {
    expect(
      parseFeedbackLease({ protocolVersion: 3, status: "empty", hasMore: false }),
    ).toBeUndefined();
    expect(parseFeedbackLease({ protocolVersion: 2, status: "future" })).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ leaseVersion: 0 })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ eventId: "event\u202e-1" })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ shortId: "ABC12345" })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event(), event()],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ intent: "x".repeat(513) })],
        hasMore: false,
      }),
    ).toBeUndefined();
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ shortId: "x\nspoof" })],
        hasMore: false,
      }),
    ).toBeUndefined();
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["terminal-unsafe", "decision\u202espoof"],
  ])("leaves a v2 publish prompt with a %s full id unacknowledged", (_label, decisionId) => {
    expect(
      parseFeedbackLease({
        protocolVersion: 2,
        status: "leased",
        events: [event({ kind: "publish_prompt", decisionId })],
        hasMore: false,
      }),
    ).toBeUndefined();
  });
});

describe("renderFeedback", () => {
  it("renders the exact linked copy and retains only the corresponding ack token", () => {
    const lease = parseFeedbackLease({
      protocolVersion: 2,
      status: "leased",
      events: [event({ webUrl })],
      hasMore: false,
    });
    expect(renderFeedback(lease as FeedbackLease)).toEqual({
      protocolVersion: 2,
      systemMessage:
        "[prim] response → created Decision (dec_a1b2c3d4): Use the stable API (https://app.getprimitive.ai/decisions/r571n1dqjdrtyxxpf0fnzee4gn8aed6q)",
      deliveries: [{ eventId: "event-1", leaseVersion: 1 }],
    });
  });

  it("renders the legacy copy when the server omits the web URL", () => {
    expect(
      renderFeedback({
        protocolVersion: 2,
        events: [event() as FeedbackLease["events"][number]],
        hasMore: false,
      }),
    ).toEqual({
      protocolVersion: 2,
      systemMessage: "[prim] response → created Decision (dec_a1b2c3d4): Use the stable API",
      deliveries: [{ eventId: "event-1", leaseVersion: 1 }],
    });
  });

  it("renders a publish prompt with the exact author action and ack token", () => {
    const lease = parseFeedbackLease({
      protocolVersion: 2,
      status: "leased",
      events: [event({ kind: "publish_prompt", decisionId: "decision-full-1", webUrl })],
      hasMore: false,
    });
    expect(renderFeedback(lease as FeedbackLease)).toEqual({
      protocolVersion: 2,
      systemMessage:
        "[prim] publish this Decision draft (dec_a1b2c3d4)? Use the stable API (https://app.getprimitive.ai/decisions/r571n1dqjdrtyxxpf0fnzee4gn8aed6q) Run `prim decisions publish decision-full-1` to share it with your team.",
      deliveries: [{ eventId: "event-1", leaseVersion: 1 }],
    });
  });

  it("includes web URLs in the 8k display budget and leaves overflow unacknowledged", () => {
    const events = Array.from({ length: 40 }, (_, index) => ({
      eventId: `event-${String(index)}`,
      leaseVersion: 1,
      shortId: `id${String(index)}`,
      intent: "x".repeat(MAX_FEEDBACK_INTENT_CODE_POINTS),
      webUrl: `https://app.getprimitive.ai/decisions/${"x".repeat(300)}`,
      decisionId: `decision-${String(index)}`,
      kind: index % 2 === 0 ? ("confirm_prompt" as const) : ("publish_prompt" as const),
    }));
    const rendered = renderFeedback({ protocolVersion: 2, events, hasMore: false });
    expect(rendered).toBeDefined();
    expect(Array.from(rendered?.systemMessage ?? "").length).toBeLessThanOrEqual(8_000);
    expect(rendered?.deliveries.length).toBeLessThan(events.length);
    expect(rendered?.deliveries).toEqual(
      events.slice(0, rendered?.deliveries.length).map(({ eventId, leaseVersion }) => ({
        eventId,
        leaseVersion,
      })),
    );
  });

  it("does not render or acknowledge a manually constructed ambiguous publish prompt", () => {
    expect(
      renderFeedback({
        protocolVersion: 2,
        events: [event({ kind: "publish_prompt" }) as FeedbackLease["events"][number]],
        hasMore: false,
      }),
    ).toBeUndefined();
  });
});

describe("feedback HTTP client", () => {
  it("leases directly with the closed request and quiet shared signal", async () => {
    const post = vi.fn().mockResolvedValue({ protocolVersion: 2, status: "empty", hasMore: false });
    const result = await leaseDecisionFeedback(
      { workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4", currentSessionId: "s1", signal },
      { client: { get: vi.fn(), post } },
    );
    expect(result).toEqual({ protocolVersion: 2, events: [], hasMore: false });
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/feedback/lease",
      {
        protocolVersion: 2,
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
      protocolVersion: 2,
      status: "acked",
      acknowledgedEventIds: ["event-1"],
    });
    await expect(
      acknowledgeDecisionFeedback(
        {
          protocolVersion: 2,
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
        protocolVersion: 2,
        workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
        deliveries: [{ eventId: "event-1", leaseVersion: 3 }],
      },
      { signal, quietRefresh: true },
    );
  });

  it("acknowledges using the protocol version that leased the feedback", async () => {
    const post = vi.fn().mockResolvedValue({
      protocolVersion: 1,
      status: "acked",
      acknowledgedEventIds: ["event-1"],
    });

    await expect(
      acknowledgeDecisionFeedback(
        {
          protocolVersion: 1,
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
    expect(parseFeedbackCapability({ protocolVersion: 2, status: "available" })).toEqual({
      status: "available",
    });
    expect(
      parseFeedbackCapability({
        protocolVersion: 2,
        status: "unavailable",
        reason: "organization_unbound",
      }),
    ).toEqual({ status: "unavailable", reason: "organization_unbound" });
    expect(parseFeedbackCapability({ protocolVersion: 1, status: "available" })).toEqual({
      status: "available",
    });
    expect(parseFeedbackCapability({ protocolVersion: 3, status: "unknown" })).toBeUndefined();
  });
});
