import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../lib/ansi.js";
import { isVerdictFooterContext, renderVerdictFooter } from "./verdict-footer.js";

const originalIsTTY = process.stdout.isTTY;

beforeEach(() => {
  // Keep the renderer's color path inactive by default — assertions
  // compare against plain text. Individual tests that exercise the
  // TTY path flip this back on for one assertion.
  Object.defineProperty(process.stdout, "isTTY", {
    value: false,
    configurable: true,
  });
});

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", {
    value: originalIsTTY,
    configurable: true,
  });
});

describe("renderVerdictFooter", () => {
  it("renders the three image-#3 fragments separated by ·", () => {
    const out = renderVerdictFooter({
      decisionsSaved: 6,
      author: "Maya",
      intent: "ignored — only used for context shaping in the test",
    });
    expect(out).toContain("✓ Conflict caught before merge");
    expect(out).toContain("6 decisions saved");
    expect(out).toContain("Maya's intent preserved");
    expect(out.split("·").length).toBe(3);
  });

  it("preserves the rendered content shape under color (TTY path)", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: true,
      configurable: true,
    });
    const out = renderVerdictFooter({
      decisionsSaved: 1,
      author: "Taylor",
      intent: "",
    });
    // ANSI codes wrap the success prefix + author bold.
    expect(stripAnsi(out)).toContain("✓ Conflict caught before merge");
    expect(stripAnsi(out)).toContain("Taylor's intent preserved");
  });

  it("handles single-decision savings without pluralization gymnastics", () => {
    const out = renderVerdictFooter({
      decisionsSaved: 1,
      author: "Jamal",
      intent: "",
    });
    // V1 keeps the "decisions" wording even at N=1 — matches image #3's
    // canonical form; pluralization polish is a future iteration.
    expect(out).toContain("1 decisions saved");
  });
});

describe("isVerdictFooterContext", () => {
  it("returns true for a well-shaped payload", () => {
    expect(
      isVerdictFooterContext({
        decisionsSaved: 5,
        author: "Maya",
        intent: "Use Redis for the cache",
      }),
    ).toBe(true);
  });

  it("returns false for null", () => {
    expect(isVerdictFooterContext(null)).toBe(false);
  });

  it("returns false for partial shapes (missing author)", () => {
    expect(isVerdictFooterContext({ decisionsSaved: 5, intent: "X" })).toBe(false);
  });

  it("returns false when decisionsSaved is the wrong type", () => {
    expect(
      isVerdictFooterContext({
        decisionsSaved: "5",
        author: "Maya",
        intent: "Use Redis",
      }),
    ).toBe(false);
  });
});
