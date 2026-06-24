/**
 * `prim welcome` — orientation + org-state coverage. Asserts the formatted block
 * (ANSI-stripped) carries the load-bearing content for each branch: the shared
 * orientation is always present; an active org inlines recent decisions; an empty
 * org shows the reverse-prompt; and an unverifiable feed degrades to the static
 * starter commands. Color is gated on a stderr TTY, so under vitest the helpers
 * already return plain text — stripAnsi keeps the assertions robust either way.
 */

import { describe, expect, it } from "vitest";
import type { DecisionFeedRow } from "../decisions/recent.js";
import { stripAnsi } from "../lib/ansi.js";
import {
  REVERSE_PROMPT,
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
  it("maps an unverifiable feed to unknown — never to empty", () => {
    expect(welcomeStateFromRecent({ decisions: [], unavailable: "boom" })).toEqual({
      org: "unknown",
    });
  });

  it("maps a healthy empty feed to empty", () => {
    expect(welcomeStateFromRecent({ decisions: [] })).toEqual({ org: "empty" });
  });

  it("maps a populated feed to active, capped at five rows", () => {
    const decisions = Array.from({ length: 7 }, (_, i) =>
      row({ id: `d${i}`, intent: `Decision ${i}` }),
    );
    const state = welcomeStateFromRecent({ decisions });
    expect(state.org).toBe("active");
    if (state.org === "active") {
      expect(state.recent).toHaveLength(5);
    }
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
    expect(plain).toContain("prim reconcile dec_<id>");
    expect(plain).toContain("App: https://app.getprimitive.ai");
    expect(plain).toContain("Recent team decisions");
    expect(plain).toContain("Restrict PII storage to EU region");
    expect(plain).toContain("Maya");
    expect(plain).not.toContain("prim decisions recent");
    expect(plain).not.toContain("…");
  });

  it("empty org: reverse-prompt asking what the user is and isn't focusing on", () => {
    const plain = plainOf({ org: "empty" });
    expect(plain).toContain("Welcome to Primitive");
    expect(plain).toContain("seed your decision graph");
    expect(plain).toContain("most important goals");
    expect(plain).toContain("not focusing on");
    expect(plain).not.toContain("prim decisions recent");
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

  it("empty carries org + the flat reverse-prompt", () => {
    expect(welcomeJson({ org: "empty" })).toEqual({
      welcomed: true,
      org: "empty",
      reversePrompt: REVERSE_PROMPT,
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
});
