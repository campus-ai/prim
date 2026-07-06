/**
 * `prim welcome` — orientation + state coverage. Asserts the formatted block
 * (ANSI-stripped) carries the load-bearing content for each branch: the shared
 * orientation is always present; a viewer with decisions inlines recent ones; a
 * viewer with none gets the reverse-prompt (with team decisions above it when the
 * org has any); and an unverifiable feed degrades to the static starter commands.
 * Color is gated on a stderr TTY, so under vitest the helpers already return plain
 * text — stripAnsi keeps the assertions robust either way.
 */

import { describe, expect, it } from "vitest";
import type { DecisionFeedRow } from "../decisions/recent.js";
import { stripAnsi } from "../lib/ansi.js";
import {
  REVERSE_PROMPT,
  REVERSE_PROMPT_TEMPLATE,
  type WelcomeState,
  formatWelcome,
  welcomeJson,
  welcomeStateFromRecent,
} from "./welcome.js";

const row = (over: Partial<DecisionFeedRow> = {}): DecisionFeedRow => ({
  id: "r570h4fj4sdza47zxzs9taend9899td2",
  shortId: "3a4b96d9",
  intent: "Move analytics warehouse to BigQuery",
  rationale: undefined,
  area: "data",
  producerKind: "claude_code",
  userId: "u1",
  authorName: "Maya",
  authorIsSelf: false,
  classifiedAt: 1_700_000_000_000,
  status: "active",
  ...over,
});

const plainOf = (state: WelcomeState): string => stripAnsi(formatWelcome(state));

describe("welcomeStateFromRecent", () => {
  it("maps an unverifiable feed to unknown — never to seed", () => {
    expect(
      welcomeStateFromRecent({ decisions: [], viewerHasDecisions: false, unavailable: "boom" }),
    ).toEqual({ org: "unknown" });
  });

  it("seeds a viewer with no decisions in an empty org (no team context)", () => {
    expect(welcomeStateFromRecent({ decisions: [], viewerHasDecisions: false })).toEqual({
      org: "seed",
      recent: [],
    });
  });

  it("seeds a viewer with no decisions even when the team has some, carrying team context", () => {
    const decisions = Array.from({ length: 7 }, (_, i) =>
      row({ id: `d${i}`, intent: `Decision ${i}` }),
    );
    const state = welcomeStateFromRecent({ decisions, viewerHasDecisions: false });
    expect(state.org).toBe("seed");
    if (state.org === "seed") {
      expect(state.recent).toHaveLength(5);
    }
  });

  it("maps a viewer who has decisions to active, capped at five rows", () => {
    const decisions = Array.from({ length: 7 }, (_, i) =>
      row({ id: `d${i}`, intent: `Decision ${i}` }),
    );
    const state = welcomeStateFromRecent({ decisions, viewerHasDecisions: true });
    expect(state.org).toBe("active");
    if (state.org === "active") {
      expect(state.recent).toHaveLength(5);
    }
  });

  it("falls back to the org-scoped signal when the server omits viewerHasDecisions", () => {
    // Pre-flag backend: a populated feed implies the viewer isn't the first
    // member → active; an empty feed → seed. Preserves prior behavior.
    expect(welcomeStateFromRecent({ decisions: [row()] }).org).toBe("active");
    expect(welcomeStateFromRecent({ decisions: [] }).org).toBe("seed");
  });
});

describe("formatWelcome", () => {
  it("active org: shared orientation + inlined recent decisions, no redundant recent line", () => {
    const plain = plainOf({
      org: "active",
      recent: [row({ intent: "Restrict PII storage to EU region" })],
    });
    expect(plain).toContain("Welcome to Primitive");
    expect(plain).toContain("Capture is automatic");
    expect(plain).toContain("Conflict Gates");
    expect(plain).toContain("not currently enabled");
    expect(plain).toContain("support@getprimitive.ai");
    expect(plain).toContain("App: https://app.getprimitive.ai");
    expect(plain).toContain("Recent team decisions");
    expect(plain).toContain("Restrict PII storage to EU region");
    expect(plain).toContain("Maya");
    expect(plain).not.toContain("prim decisions recent");
    expect(plain).not.toContain("…");
  });

  it("seed (empty org): ruled question callout is the terminal call-to-action, no team block, no footer after", () => {
    const plain = plainOf({ org: "seed", recent: [] });
    expect(plain).toContain("Welcome to Primitive");
    expect(plain).toContain("seed your decision graph");
    expect(plain).toContain("You haven't recorded a decision yet");
    expect(plain).toContain("Your turn");
    expect(plain).toContain("most important goals");
    expect(plain).toContain("not focusing on");
    expect(plain).not.toContain("Recent team decisions");
    expect(plain).not.toContain("prim decisions recent");
    // The question is the LAST thing the user sees: the callout's bottom rule
    // ends the block, and the App footer is suppressed so nothing follows it.
    expect(plain).not.toContain("App: https://app.getprimitive.ai");
    expect(plain.trimEnd().endsWith("┘")).toBe(true);
    // The review template is agent-only (JSON): the human render never carries
    // its unfilled $FOUND_GOALS slot.
    expect(plain).not.toContain("$FOUND_GOALS");
  });

  it("seed (active org): team decisions inlined above the ruled question callout, question still terminal", () => {
    const plain = plainOf({
      org: "seed",
      recent: [row({ intent: "Restrict PII storage to EU region" })],
    });
    expect(plain).toContain("Recent team decisions");
    expect(plain).toContain("Restrict PII storage to EU region");
    expect(plain).toContain("Maya");
    expect(plain).toContain("Your turn");
    expect(plain).toContain("You haven't recorded a decision yet");
    expect(plain).toContain("most important goals");
    expect(plain).not.toContain("prim decisions recent");
    // Team context sits ABOVE the question; the question is still terminal.
    expect(plain.indexOf("Recent team decisions")).toBeLessThan(plain.indexOf("Your turn"));
    expect(plain.trimEnd().endsWith("┘")).toBe(true);
  });

  it("unknown feed: shared orientation + static starter-command fallback", () => {
    const plain = plainOf({ org: "unknown" });
    expect(plain).toContain("Welcome to Primitive");
    expect(plain).toContain("prim decisions recent");
    expect(plain).toContain("prim decisions check --files <files>");
    expect(plain).toContain("prim --help");
  });
});

describe("welcomeJson", () => {
  it("active carries org + the recent rows", () => {
    const recent = [row()];
    expect(welcomeJson({ org: "active", recent })).toEqual({
      welcomed: true,
      org: "active",
      recent,
    });
  });

  it("seed carries org + the flat reverse-prompt + the review template + team context", () => {
    const recent = [row()];
    expect(welcomeJson({ org: "seed", recent })).toEqual({
      welcomed: true,
      org: "seed",
      reversePrompt: REVERSE_PROMPT,
      reversePromptTemplate: REVERSE_PROMPT_TEMPLATE,
      recent,
    });
  });

  it("seed in an empty org carries an empty recent array", () => {
    expect(welcomeJson({ org: "seed", recent: [] })).toEqual({
      welcomed: true,
      org: "seed",
      reversePrompt: REVERSE_PROMPT,
      reversePromptTemplate: REVERSE_PROMPT_TEMPLATE,
      recent: [],
    });
  });

  it("unknown carries just the org", () => {
    expect(welcomeJson({ org: "unknown" })).toEqual({ welcomed: true, org: "unknown" });
  });

  it("REVERSE_PROMPT is the verbatim onboarding question", () => {
    expect(REVERSE_PROMPT).toBe(
      "What are the most important goals in your organization that you're responsible for, right now? What are you not focusing on, in order to focus on those goals?",
    );
  });

  it("REVERSE_PROMPT_TEMPLATE is the verbatim review framing with the $FOUND_GOALS slot", () => {
    expect(REVERSE_PROMPT_TEMPLATE).toBe(
      "We're interested in learning your current goals, as well as what you're not focusing on to achieve those goals. We found the following:\n\n$FOUND_GOALS\n\nHow do these look to you? Would you like to change these goals?",
    );
  });
});
