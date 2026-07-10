import { describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";
import {
  FEEDBACK_DESCRIPTION_MAX_CHARS,
  cleanFeedbackDescription,
  drainDecisionFeedback,
  formatDecisionCreatedFeedback,
  formatDecisionFeedbackSystemMessage,
} from "./feedback.js";

const EVENT = {
  decisionId: "jx7fpmycwabtzke040y7vecnnh8870pg",
  shortId: "abc12345",
  intent: "Adopt BigQuery for analytics events",
};

function clientWith(post: CliClient["post"]): CliClient {
  return {
    post,
    get: () => {
      throw new Error("unexpected GET call");
    },
  };
}

describe("formatDecisionCreatedFeedback", () => {
  it("renders the short decision id and intent", () => {
    expect(formatDecisionCreatedFeedback(EVENT)).toBe(
      "[prim] response → created Decision (dec_abc12345): Adopt BigQuery for analytics events",
    );
  });

  it("falls back to the full decision id", () => {
    expect(formatDecisionCreatedFeedback({ ...EVENT, shortId: undefined })).toContain(
      "(jx7fpmycwabtzke040y7vecnnh8870pg)",
    );
  });

  it("cleans control characters and collapses whitespace", () => {
    expect(cleanFeedbackDescription("  Adopt\n\tRedis\u0007  for   caching  ")).toBe(
      "Adopt Redis for caching",
    );
  });

  it("truncates long descriptions", () => {
    const out = cleanFeedbackDescription("x".repeat(FEEDBACK_DESCRIPTION_MAX_CHARS + 10));
    expect(out).toHaveLength(FEEDBACK_DESCRIPTION_MAX_CHARS);
    expect(out.endsWith("…")).toBe(true);
  });
});

describe("formatDecisionFeedbackSystemMessage", () => {
  it("joins multiple decision feedback lines", () => {
    const message = formatDecisionFeedbackSystemMessage([
      EVENT,
      { ...EVENT, shortId: "def67890", intent: "Use Redis for cache invalidation" },
    ]);
    expect(message).toContain("dec_abc12345");
    expect(message).toContain("\n");
    expect(message).toContain("dec_def67890");
  });

  it("returns undefined for an empty event list", () => {
    expect(formatDecisionFeedbackSystemMessage([])).toBeUndefined();
  });
});

describe("drainDecisionFeedback", () => {
  it("posts to the drain endpoint and returns feedback rows", async () => {
    const post = vi.fn().mockResolvedValue({ feedback: [EVENT] });
    const result = await drainDecisionFeedback(
      { repoCwd: "/repo", scope: "session", sessionId: "sess-123" },
      { getClient: () => clientWith(post) },
    );
    expect(result).toEqual([EVENT]);
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/feedback/drain",
      { consumer: "claude_code", repoCwd: "/repo", scope: "session", sessionId: "sess-123" },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("treats malformed responses as no feedback", async () => {
    const post = vi.fn().mockResolvedValue({});
    await expect(
      drainDecisionFeedback(
        { repoCwd: "/repo", scope: "session", sessionId: "sess-123" },
        { getClient: () => clientWith(post) },
      ),
    ).resolves.toEqual([]);
  });

  it("drops malformed rows without dropping valid feedback", async () => {
    const post = vi.fn().mockResolvedValue({
      feedback: [EVENT, { decisionId: "missing-intent" }, null],
    });
    await expect(
      drainDecisionFeedback(
        { repoCwd: "/repo", scope: "session", sessionId: "sess-123" },
        { getClient: () => clientWith(post) },
      ),
    ).resolves.toEqual([EVENT]);
  });
});
