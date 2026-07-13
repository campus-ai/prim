import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  normalizeFeedbackIntent,
  parseFeedbackCapability,
  parseFeedbackLease,
  renderFeedback,
} from "./feedback.js";

const EXPECTED_FIXTURE_SHA256 = "368255ebd79a84fa6b32d706b0e35f26c0c2719a249bc8eeb6906b4226a61cd9";
const bytes = readFileSync(resolve("contracts", "decision-feedback-v1.json"));
const fixture = JSON.parse(bytes.toString("utf8")) as {
  moveEnvelopes: {
    legacyV1: { envelopeVersion: number; producer?: string };
    claudeV2: { envelopeVersion: number; producer: string };
    codexV2: { envelopeVersion: number; producer: string };
    hermesV2: { envelopeVersion: number; producer: string };
  };
  lease: { request: unknown; leased: unknown; empty: unknown; unavailable: unknown };
  ack: { request: unknown; response: unknown };
  status: { available: unknown; unavailable: unknown };
  normalization: Array<{ input: string; expected: string }>;
  rendered: string;
};

describe("decision feedback mirrored contract", () => {
  it("pins the byte-identical cross-repository fixture", () => {
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(EXPECTED_FIXTURE_SHA256);
  });

  it("pins normalization and the exact human-visible copy", () => {
    for (const example of fixture.normalization) {
      expect(normalizeFeedbackIntent(example.input)).toBe(example.expected);
    }
    const lease = parseFeedbackLease(fixture.lease.leased);
    expect(lease).toBeDefined();
    if (!lease) throw new Error("fixture lease must parse");
    expect(renderFeedback(lease)?.systemMessage).toBe(fixture.rendered);
  });

  it("pins producer parity and every response branch", () => {
    expect(fixture.moveEnvelopes.legacyV1).toMatchObject({ envelopeVersion: 1 });
    expect(fixture.moveEnvelopes.legacyV1.producer).toBeUndefined();
    expect(fixture.moveEnvelopes.claudeV2).toMatchObject({
      envelopeVersion: 2,
      producer: "claude_code",
    });
    expect(fixture.moveEnvelopes.codexV2).toMatchObject({
      envelopeVersion: 2,
      producer: "codex",
    });
    expect(fixture.moveEnvelopes.hermesV2).toMatchObject({
      envelopeVersion: 2,
      producer: "hermes",
    });
    expect(parseFeedbackLease(fixture.lease.empty)).toEqual({ events: [], hasMore: false });
    expect(parseFeedbackLease(fixture.lease.unavailable)).toEqual({
      events: [],
      hasMore: false,
    });
    expect(parseFeedbackCapability(fixture.status.available)).toEqual({ status: "available" });
    expect(parseFeedbackCapability(fixture.status.unavailable)).toEqual({
      status: "unavailable",
      reason: "organization_unbound",
    });
  });
});
