/**
 * `prim decisions show` — formatter coverage.
 *
 * Tests `formatShowHuman` against representative shapes the server
 * emits: full row with rationale + refs + dependents, missing
 * optional fields, and a row with a pending confirmation_request flag.
 */

import { describe, expect, it } from "vitest";
import { type DecisionShowResult, formatShowHuman, formatShowJson } from "./show.js";

const DETAIL: DecisionShowResult = {
  decision: {
    _id: "qx7fpmycwabtzke040y7vecnnh8870pg",
    sessionId: "verify-fix3-1",
    userId: "u_taylor",
    intent: "Update the AUTH_PROVIDER constant",
    intentKind: "change",
    rationale: "Verification flow",
    alternatives: ["leave as-is", "remove provider"],
    confidence: "high",
    reversibility: "high",
    status: "active",
    confirmed: false,
    area: "auth",
    producerKind: "claude_code",
    shortId: "230a72aa",
    classifiedAt: Date.UTC(2026, 5, 7, 19, 9, 37),
    classifierVersion: "intent_v2",
    model: "claude-sonnet-4-6",
  },
  flags: [
    {
      _id: "rd_x1",
      decisionId: "qx7fpmycwabtzke040y7vecnnh8870pg",
      triggeredByType: "confirmation_request",
      flaggedAt: Date.UTC(2026, 5, 7, 19, 30, 0),
    },
  ],
  fileRefs: [
    {
      _id: "rf_x1",
      decisionId: "qx7fpmycwabtzke040y7vecnnh8870pg",
      file: "convex/auth-strategy.ts",
    },
  ],
  contextRefs: [
    {
      _id: "rc_x1",
      decisionId: "qx7fpmycwabtzke040y7vecnnh8870pg",
      contextId: "k_auth",
      accessKind: "read",
    },
  ],
  depsOn: [],
  dependents: [],
};

describe("formatShowHuman", () => {
  it("verdicts the decision with id, intent, status, and area", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("dec_230a72aa");
    expect(out).toContain("Update the AUTH_PROVIDER constant");
    expect(out).toContain("status: active");
    expect(out).toContain("area: auth");
  });

  it("renders alternatives and rationale", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("rationale: Verification flow");
    expect(out).toContain("alternatives: leave as-is | remove provider");
  });

  it("notes the pending confirmation request in the flags list", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("pending confirmation request");
  });

  it("omits the rationale line when not present", () => {
    const noRationale = {
      ...DETAIL,
      decision: { ...DETAIL.decision, rationale: undefined },
    };
    const out = formatShowHuman(noRationale);
    expect(out).not.toContain("rationale:");
  });

  it("renders the raw _id when shortId is absent", () => {
    const noShortId = {
      ...DETAIL,
      decision: { ...DETAIL.decision, shortId: undefined },
    };
    const out = formatShowHuman(noShortId);
    expect(out).toContain("qx7fpmycwabtzke040y7vecnnh8870pg");
  });

  it("renders dependents by intent + area, not raw ids", () => {
    const withDeps: DecisionShowResult = {
      ...DETAIL,
      dependents: [
        {
          id: "qx7childaaaaaaaaaaaaaaaaaaaaaaaa",
          shortId: "abcd1234",
          intent: "Session storage reads from Redis",
          area: "auth",
        },
      ],
      depsOn: [
        {
          id: "qx7parentbbbbbbbbbbbbbbbbbbbbbbbb",
          shortId: "ef567890",
          intent: "Use Redis for the verification cache",
          area: "infra",
        },
      ],
    };
    const out = formatShowHuman(withDeps);
    expect(out).toContain("Session storage reads from Redis");
    expect(out).toContain("[auth]");
    expect(out).toContain("dec_abcd1234");
    expect(out).toContain("Use Redis for the verification cache");
    expect(out).not.toContain("qx7childaaaaaaaaaaaaaaaaaaaaaaaa");
  });
});

describe("formatShowJson", () => {
  it("emits stable JSON with the decision shape preserved", () => {
    const parsed = JSON.parse(formatShowJson(DETAIL));
    expect(parsed.decision._id).toBe(DETAIL.decision._id);
    expect(parsed.flags).toHaveLength(1);
  });
});
