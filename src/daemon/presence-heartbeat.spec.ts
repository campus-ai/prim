import { describe, expect, it } from "vitest";
import { isPresenceHeartbeatRequest } from "../contract/cli-http-v1.js";
import { DECISION_LIFECYCLE_PROTOCOL_VERSION } from "../protocol/decision-lifecycle.js";
import { buildPresenceHeartbeatRequest } from "./presence-heartbeat.js";

const clientInstanceId = `pci_${"a".repeat(43)}`;

describe("daemon presence heartbeat contract", () => {
  it("advertises the exact supported Decision lifecycle protocol additively", () => {
    const request = buildPresenceHeartbeatRequest("session-1", clientInstanceId);
    expect(request).toEqual({
      sessionId: "session-1",
      clientInstanceId,
      decisionLifecycleProtocolVersion: DECISION_LIFECYCLE_PROTOCOL_VERSION,
    });
    expect(DECISION_LIFECYCLE_PROTOCOL_VERSION).toBe(2);
    expect(isPresenceHeartbeatRequest(request)).toBe(true);
    expect(isPresenceHeartbeatRequest({ sessionId: "session-1" })).toBe(true);
    expect(
      isPresenceHeartbeatRequest({
        sessionId: "session-1",
        clientInstanceId: "alice-personal-macbook.local",
      }),
    ).toBe(false);
  });

  it("fails closed on a malformed or PII-bearing instance id", () => {
    expect(() =>
      buildPresenceHeartbeatRequest("session-1", "alice-personal-macbook.local"),
    ).toThrow("presence heartbeat identity or session is invalid");
  });
});
