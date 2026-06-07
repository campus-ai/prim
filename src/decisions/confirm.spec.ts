/**
 * `prim decisions confirm` — formatter coverage.
 *
 * Tests the three branches of `formatConfirmHuman`: fresh ack,
 * idempotent re-ack (alreadyAcknowledged=true), and no-pending-flag
 * fall-through (flagId === null).
 */

import { describe, expect, it } from "vitest";
import { type ConfirmResult, formatConfirmHuman, formatConfirmJson } from "./confirm.js";

const FRESH_ACK: ConfirmResult = {
  decisionId: "qx7fpmycwabtzke040y7vecnnh8870pg",
  shortId: "230a72aa",
  confirmed: true,
  flagId: "rd7xnz0001",
  alreadyAcknowledged: false,
};

const ALREADY_ACKED: ConfirmResult = {
  ...FRESH_ACK,
  alreadyAcknowledged: true,
};

const NO_PENDING: ConfirmResult = {
  decisionId: "qx7fpmycwabtzke040y7vecnnh8870pg",
  shortId: "230a72aa",
  confirmed: false,
  flagId: null,
  alreadyAcknowledged: false,
};

describe("formatConfirmHuman", () => {
  it("verdicts a fresh acknowledgment", () => {
    expect(formatConfirmHuman(FRESH_ACK)).toBe(
      "[prim] dec_230a72aa acknowledged (confirmed=true).",
    );
  });

  it("verdicts an idempotent re-acknowledgment", () => {
    expect(formatConfirmHuman(ALREADY_ACKED)).toBe(
      "[prim] dec_230a72aa was already acknowledged (confirmed=true).",
    );
  });

  it("verdicts the no-pending-flag fall-through honestly", () => {
    const out = formatConfirmHuman(NO_PENDING);
    expect(out).toContain("has no pending confirmation request");
    expect(out).toContain("nothing to acknowledge");
    expect(out).toContain("current confirmed=false");
  });
});

describe("formatConfirmJson", () => {
  it("emits stable JSON for the result", () => {
    const parsed = JSON.parse(formatConfirmJson(FRESH_ACK));
    expect(parsed.alreadyAcknowledged).toBe(false);
    expect(parsed.flagId).toBe("rd7xnz0001");
  });
});
