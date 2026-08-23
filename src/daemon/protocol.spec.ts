import { describe, expect, it } from "vitest";
import { parseDaemonRequestEnvelope, parseDaemonResponseEnvelope } from "./protocol.js";

const principal = {
  principalId: "a".repeat(64),
  organizationId: "org_1",
  credentialFingerprint: "b".repeat(64),
};

describe("daemon socket envelopes", () => {
  it("accepts the additive caller principal", () => {
    expect(
      parseDaemonRequestEnvelope({ id: 1, method: "ping", params: {}, caller: principal }),
    ).toEqual({ id: 1, method: "ping", params: {}, caller: principal });
  });

  it("rejects malformed ids, methods, params, and principals", () => {
    expect(parseDaemonRequestEnvelope({ id: -1, method: "ping" })).toBeUndefined();
    expect(parseDaemonRequestEnvelope({ id: 1, method: "" })).toBeUndefined();
    expect(parseDaemonRequestEnvelope({ id: 1, method: "ping", params: [] })).toBeUndefined();
    expect(
      parseDaemonRequestEnvelope({
        id: 1,
        method: "ping",
        caller: { ...principal, principalId: "x" },
      }),
    ).toBeUndefined();
  });

  it("validates response structure before trusting result data", () => {
    expect(parseDaemonResponseEnvelope({ id: 1, ok: true, result: { pong: true } })).toEqual({
      id: 1,
      ok: true,
      result: { pong: true },
    });
    expect(parseDaemonResponseEnvelope({ id: 1, ok: "true" })).toBeUndefined();
    expect(parseDaemonResponseEnvelope({ id: Number.NaN, ok: true })).toBeUndefined();
  });
});
