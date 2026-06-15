/**
 * `prim decisions confirm` — formatter coverage against the merged
 * server `ConfirmOutcome` union.
 *
 * Covers every observable outcome: the freshly-applied trio
 * (confirmed / corrected / stale, worded off the request intent), the
 * idempotent already_responded no-op, the nothing-to-acknowledge
 * no_pending_prompt fall-through, and the two error outcomes the server
 * expresses as HTTP status (ambiguous / not_author) which fetchConfirm
 * folds back into the union. Also asserts formatConfirmJson emits the
 * server outcome verbatim.
 */

import { describe, expect, it } from "vitest";
import {
  type ConfirmRequest,
  type ConfirmResult,
  formatConfirmHuman,
  formatConfirmJson,
} from "./confirm.js";

const DECISION_ID = "qx7fpmycwabtzke040y7vecnnh8870pg";
const SHORT_ID = "230a72aa";

const CONFIRMED_REQUEST: ConfirmRequest = {
  idOrShortId: "dec_230a72aa",
  confirmed: true,
};

const REJECTED_REQUEST: ConfirmRequest = {
  idOrShortId: "dec_230a72aa",
  confirmed: false,
};

describe("formatConfirmHuman — freshly applied", () => {
  it("verdicts a confirmed application off the request intent", () => {
    const result: ConfirmResult = {
      request: CONFIRMED_REQUEST,
      outcome: { outcome: "confirmed", decisionId: DECISION_ID, shortId: SHORT_ID },
    };
    expect(formatConfirmHuman(result)).toBe("[prim] dec_230a72aa confirmed.");
  });

  it("verdicts a rejected application off the request intent", () => {
    const result: ConfirmResult = {
      request: REJECTED_REQUEST,
      outcome: { outcome: "confirmed", decisionId: DECISION_ID, shortId: SHORT_ID },
    };
    expect(formatConfirmHuman(result)).toBe("[prim] dec_230a72aa rejected.");
  });

  it("notes a correction for the corrected outcome", () => {
    const result: ConfirmResult = {
      request: CONFIRMED_REQUEST,
      outcome: { outcome: "corrected", decisionId: DECISION_ID, shortId: SHORT_ID },
    };
    const out = formatConfirmHuman(result);
    expect(out).toContain("dec_230a72aa confirmed");
    expect(out).toContain("with a correction");
  });

  it("flags a stale prompt while still recording the answer", () => {
    const result: ConfirmResult = {
      request: REJECTED_REQUEST,
      outcome: { outcome: "stale", decisionId: DECISION_ID, shortId: SHORT_ID },
    };
    const out = formatConfirmHuman(result);
    expect(out).toContain("dec_230a72aa rejected");
    expect(out).toContain("gone stale");
  });

  it("falls back to the raw id when shortId is absent", () => {
    const result: ConfirmResult = {
      request: { idOrShortId: DECISION_ID, confirmed: true },
      outcome: { outcome: "confirmed", decisionId: DECISION_ID, shortId: undefined },
    };
    expect(formatConfirmHuman(result)).toBe(`[prim] ${DECISION_ID} confirmed.`);
  });
});

describe("formatConfirmHuman — terminal no-ops", () => {
  it("reports an idempotent already_responded with the prior answer and time", () => {
    const respondedAt = Date.parse("2026-06-15T12:00:00.000Z");
    const result: ConfirmResult = {
      request: CONFIRMED_REQUEST,
      outcome: {
        outcome: "already_responded",
        decisionId: DECISION_ID,
        shortId: SHORT_ID,
        confirmed: false,
        respondedAt,
      },
    };
    const out = formatConfirmHuman(result);
    expect(out).toContain("dec_230a72aa was already rejected");
    expect(out).toContain("2026-06-15T12:00:00.000Z");
    expect(out).toContain("nothing to change");
  });

  it("handles an already_responded with an unknown prior confirmed flag", () => {
    const respondedAt = Date.parse("2026-06-15T12:00:00.000Z");
    const result: ConfirmResult = {
      request: CONFIRMED_REQUEST,
      outcome: {
        outcome: "already_responded",
        decisionId: DECISION_ID,
        shortId: SHORT_ID,
        confirmed: undefined,
        respondedAt,
      },
    };
    expect(formatConfirmHuman(result)).toContain("was already answered");
  });

  it("verdicts the no_pending_prompt fall-through honestly", () => {
    const result: ConfirmResult = {
      request: CONFIRMED_REQUEST,
      outcome: { outcome: "no_pending_prompt", decisionId: DECISION_ID, shortId: SHORT_ID },
    };
    const out = formatConfirmHuman(result);
    expect(out).toContain("no pending confirmation request");
    expect(out).toContain("nothing to acknowledge");
  });
});

describe("formatConfirmHuman — folded HTTP errors", () => {
  it("renders the ambiguous shortId outcome distinctly", () => {
    const result: ConfirmResult = {
      request: { idOrShortId: "230", confirmed: true },
      outcome: { outcome: "ambiguous" },
    };
    const out = formatConfirmHuman(result);
    expect(out).toContain('"230" is ambiguous');
    expect(out).toContain("full decision id");
  });

  it("renders the not_author outcome distinctly", () => {
    const result: ConfirmResult = {
      request: CONFIRMED_REQUEST,
      outcome: { outcome: "not_author" },
    };
    expect(formatConfirmHuman(result)).toContain("only the decision's author can respond");
  });
});

describe("formatConfirmJson", () => {
  it("emits the server outcome verbatim", () => {
    const result: ConfirmResult = {
      request: CONFIRMED_REQUEST,
      outcome: { outcome: "confirmed", decisionId: DECISION_ID, shortId: SHORT_ID },
    };
    const parsed = JSON.parse(formatConfirmJson(result)) as {
      outcome: string;
      decisionId: string;
      shortId: string;
    };
    expect(parsed.outcome).toBe("confirmed");
    expect(parsed.decisionId).toBe(DECISION_ID);
    expect(parsed.shortId).toBe(SHORT_ID);
  });
});
