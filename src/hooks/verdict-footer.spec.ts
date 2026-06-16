import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../lib/ansi.js";
import {
  type VerdictFooterContext,
  isVerdictFooterContext,
  renderVerdictFooter,
} from "./verdict-footer.js";

const originalIsTTY = process.stderr.isTTY;

beforeEach(() => {
  // Color gates on stderr.isTTY; keep it off so assertions compare plain text.
  Object.defineProperty(process.stderr, "isTTY", { value: false, configurable: true });
});

afterEach(() => {
  Object.defineProperty(process.stderr, "isTTY", { value: originalIsTTY, configurable: true });
});

function footer(overrides: Partial<VerdictFooterContext> = {}): VerdictFooterContext {
  return {
    author: "Maya",
    intent: "Use Redis for the cache",
    decisionsSaved: 6,
    decisionsSavedTruncated: false,
    decisionId: "k_decision",
    decisionShortId: "abc12345",
    ...overrides,
  };
}

describe("renderVerdictFooter", () => {
  it("renders the three fragments separated by ·", () => {
    const out = renderVerdictFooter(footer());
    expect(out).toContain("✓ Conflict caught before merge");
    expect(out).toContain("6 decisions saved");
    expect(out).toContain("Maya's intent preserved");
    expect(out.split("·").length).toBe(3);
  });

  it("renders a capped count as N+ when decisionsSavedTruncated is set", () => {
    const out = renderVerdictFooter(footer({ decisionsSaved: 50, decisionsSavedTruncated: true }));
    expect(out).toContain("50+ decisions saved");
  });

  it("renders an exact count without a + when not truncated", () => {
    const out = renderVerdictFooter(footer({ decisionsSaved: 3, decisionsSavedTruncated: false }));
    expect(out).toContain("3 decisions saved");
    expect(out).not.toContain("3+ decisions saved");
  });

  it("preserves the content shape under color (stderr TTY path)", () => {
    Object.defineProperty(process.stderr, "isTTY", { value: true, configurable: true });
    const out = renderVerdictFooter(footer({ author: "Taylor" }));
    // ANSI codes wrap the success prefix + the bold author; stripping recovers it.
    expect(out).not.toBe(stripAnsi(out));
    expect(stripAnsi(out)).toContain("✓ Conflict caught before merge");
    expect(stripAnsi(out)).toContain("Taylor's intent preserved");
  });

  it("keeps the 'decisions' wording even at a single saved decision", () => {
    const out = renderVerdictFooter(footer({ decisionsSaved: 1 }));
    expect(out).toContain("1 decisions saved");
  });
});

describe("isVerdictFooterContext", () => {
  it("returns true for a full server payload", () => {
    expect(isVerdictFooterContext(footer())).toBe(true);
  });

  it("returns true even when decisionShortId is undefined (the server sends it so)", () => {
    expect(isVerdictFooterContext(footer({ decisionShortId: undefined }))).toBe(true);
  });

  it("returns false for null", () => {
    expect(isVerdictFooterContext(null)).toBe(false);
  });

  it("returns false when a required field is missing (author)", () => {
    expect(
      isVerdictFooterContext({
        intent: "x",
        decisionsSaved: 1,
        decisionsSavedTruncated: false,
        decisionId: "k",
      }),
    ).toBe(false);
  });

  it("returns false when decisionsSavedTruncated is absent", () => {
    expect(
      isVerdictFooterContext({ author: "Maya", intent: "x", decisionsSaved: 1, decisionId: "k" }),
    ).toBe(false);
  });

  it("returns false when decisionsSaved is the wrong type", () => {
    expect(
      isVerdictFooterContext({
        author: "Maya",
        intent: "x",
        decisionsSaved: "5",
        decisionsSavedTruncated: false,
        decisionId: "k",
      }),
    ).toBe(false);
  });
});
