import { describe, expect, it } from "vitest";
import { type PreflightResponse, resultForPreflight } from "./preflight-v3.js";

const FULL_ID = "qx7fpmycwabtzke040y7vecnnh8870pg";
const WEB_URL = `https://app.getprimitive.ai/decisions/${FULL_ID}`;

function blocked(conflicts: PreflightResponse["conflicts"]): PreflightResponse {
  return {
    protocolVersion: 3,
    verdict: "block",
    reasonCode: "high_confidence_contradiction",
    message: "The proposed change conflicts with an active governing Decision.",
    conflicts,
    bypassed: [],
  };
}

describe("resultForPreflight deny directives", () => {
  it("links the governing Decision before the reconcile directive", () => {
    const result = resultForPreflight(blocked([{ decisionId: FULL_ID, shortId: "0123abcd" }]));

    expect(result.verdict).toBe("deny");
    expect(result.reason.split("\n")).toEqual([
      "The proposed change conflicts with an active governing Decision.",
      `Governing Decision: ${WEB_URL}`,
      "To reconcile, run: prim reconcile dec_0123abcd",
    ]);
    expect(result.additionalContext).toContain(`Governing Decision: ${WEB_URL}`);
  });

  it("omits the link when the full id is unsafe to render", () => {
    const result = resultForPreflight(blocked([{ decisionId: "bad\x1b[2J", shortId: "0123abcd" }]));

    expect(result.reason).not.toContain("Governing Decision:");
    expect(result.reason).toContain("To reconcile, run: prim reconcile dec_0123abcd");
    expect(result.reason).not.toContain("\x1b");
  });
});
