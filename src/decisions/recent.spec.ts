/**
 * `prim decisions recent` — formatter coverage.
 *
 * Tests the pure formatters (`formatRecentHuman`, `formatRecentJson`)
 * and the `renderIdentifier` helper. The fetch path is exercised by
 * the live-deployment smoke documented in
 * eden-prairie/.context/decision-events/cli-ux-m1-m2-results.md.
 */

import { describe, expect, it } from "vitest";
import {
  type DecisionFeedRow,
  formatRecentHuman,
  formatRecentJson,
  renderIdentifier,
} from "./recent.js";

const SELF_ROW: DecisionFeedRow = {
  id: "qx7fpmycwabtzke040y7vecnnh8870pg",
  shortId: "230a72aa",
  intent: "Update the AUTH_PROVIDER constant to mark WorkOS as verified",
  rationale: "Verification flow",
  area: "auth",
  producerKind: "claude_code",
  userId: "u_taylor",
  authorName: "Taylor",
  authorIsSelf: true,
  classifiedAt: Date.UTC(2026, 5, 7, 19, 9, 37),
  status: "active",
};

const TEAMMATE_ROW: DecisionFeedRow = {
  id: "qx70t5ks31z4gbf303ze3v0nb58878wz",
  shortId: "18294ea6",
  intent: "Pick a TTL",
  rationale: undefined,
  area: "billing",
  producerKind: "chat",
  userId: "u_maya",
  authorName: "Maya",
  authorIsSelf: false,
  classifiedAt: Date.UTC(2026, 5, 7, 19, 8, 64),
  status: "active",
};

describe("formatRecentHuman", () => {
  it("returns the empty-feed verdict when there are no decisions", () => {
    expect(formatRecentHuman({ decisions: [] })).toBe("[prim] recent · 0 decisions");
  });

  it("renders Your Claude Code for a self row with claude_code producer", () => {
    const out = formatRecentHuman({ decisions: [SELF_ROW] });
    expect(out).toContain("Your Claude Code");
    expect(out).toContain("• auth");
    expect(out).toContain(SELF_ROW.intent);
  });

  it("renders the human display name for a teammate row", () => {
    const out = formatRecentHuman({ decisions: [TEAMMATE_ROW] });
    expect(out).toContain("Maya");
    expect(out).not.toContain("Your");
    expect(out).toContain("• billing");
  });

  it("renders a hyphen-ish placeholder when area is undefined", () => {
    const out = formatRecentHuman({
      decisions: [{ ...SELF_ROW, area: undefined }],
    });
    expect(out).toContain("•  ");
  });
});

describe("formatRecentJson", () => {
  it("emits stable JSON with the decisions array", () => {
    const out = formatRecentJson({ decisions: [SELF_ROW] });
    const parsed = JSON.parse(out);
    expect(parsed.decisions).toHaveLength(1);
    expect(parsed.decisions[0].shortId).toBe(SELF_ROW.shortId);
  });

  it("emits an empty decisions array verbatim", () => {
    const out = formatRecentJson({ decisions: [] });
    expect(JSON.parse(out)).toEqual({ decisions: [] });
  });
});

describe("renderIdentifier", () => {
  it("prefixes shortId with dec_", () => {
    expect(renderIdentifier({ shortId: "8c2f1a07", id: "x" })).toBe("dec_8c2f1a07");
  });

  it("falls back to the raw id when shortId is undefined", () => {
    expect(renderIdentifier({ shortId: undefined, id: "qx7fpmyc" })).toBe("qx7fpmyc");
  });
});
