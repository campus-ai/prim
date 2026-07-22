/**
 * `prim welcome` — orientation + state coverage. Asserts the formatted block
 * (ANSI-stripped) carries the load-bearing content for each branch: the shared
 * orientation is always present; a viewer with decisions inlines recent ones; a
 * viewer with none gets the seeding block (with team decisions above it when the
 * org has any); and an unverifiable feed degrades to the static starter commands.
 * Color is gated on a stderr TTY, so under vitest the helpers already return plain
 * text — stripAnsi keeps the assertions robust either way.
 */

import { describe, expect, it } from "vitest";
import type { DecisionFeedRow } from "../decisions/recent.js";
import { stripAnsi } from "../lib/ansi.js";
import {
  SEED_GUIDANCE,
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

  it("seed (empty org): seeding block explains the proposal pass and the standing guidance, no team block", () => {
    const plain = plainOf({ org: "seed", recent: [] });
    expect(plain).toContain("Welcome to Primitive");
    expect(plain).toContain("seed your decision graph");
    expect(plain).toContain("You haven't recorded a decision yet");
    // Source transparency + no overpromise: the copy names where candidates
    // come from (stated context + shared repo memory) and never guarantees
    // proposals will materialize — a cold-start agent may find none.
    expect(plain).toContain("what you've told it");
    expect(plain).toContain("shared memory files");
    expect(plain).toContain("any decisions it finds");
    // Team-visibility disclosure: the user must hear, before approving
    // anything, that seeded decisions land in the team's shared graph.
    expect(plain).toContain("team's shared graph");
    expect(plain).toContain("From here on");
    expect(plain).toContain("add any decision to Primitive");
    expect(plain).toContain("captures decisions passively");
    expect(plain).toContain("prim enable");
    expect(plain).toContain("App: https://app.getprimitive.ai");
    expect(plain).not.toContain("Recent team decisions");
    expect(plain).not.toContain("prim decisions recent");
    // The open goals question is gone: seeding is proposal-driven, one at a
    // time, per the prim skill — no interview rendered here.
    expect(plain).not.toContain("most important goals");
    expect(plain).not.toContain("Your turn");
  });

  it("seed (active org): team decisions inlined above the seeding block", () => {
    const plain = plainOf({
      org: "seed",
      recent: [row({ intent: "Restrict PII storage to EU region" })],
    });
    expect(plain).toContain("Recent team decisions");
    expect(plain).toContain("Restrict PII storage to EU region");
    expect(plain).toContain("Maya");
    expect(plain).toContain("You haven't recorded a decision yet");
    expect(plain).toContain("From here on");
    expect(plain).not.toContain("prim decisions recent");
    expect(plain.indexOf("Recent team decisions")).toBeLessThan(
      plain.indexOf("seed your decision graph"),
    );
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

  it("seed carries org + the standing guidance + team context", () => {
    const recent = [row()];
    expect(welcomeJson({ org: "seed", recent })).toEqual({
      welcomed: true,
      org: "seed",
      seedGuidance: SEED_GUIDANCE,
      recent,
    });
  });

  it("seed in an empty org carries an empty recent array", () => {
    expect(welcomeJson({ org: "seed", recent: [] })).toEqual({
      welcomed: true,
      org: "seed",
      seedGuidance: SEED_GUIDANCE,
      recent: [],
    });
  });

  it("unknown carries just the org", () => {
    expect(welcomeJson({ org: "unknown" })).toEqual({ welcomed: true, org: "unknown" });
  });

  it("SEED_GUIDANCE is the verbatim standing guidance the agent surfaces after its final proposal", () => {
    expect(SEED_GUIDANCE).toBe(
      "You can tell your agent to add any decision to your Primitive decision graph at any time. Otherwise, Primitive passively captures decisions in the background while you work. To capture decisions in other repositories, enable Primitive there too: run `prim enable` in each one.",
    );
  });
});
