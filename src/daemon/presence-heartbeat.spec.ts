import { describe, expect, it } from "vitest";
import { isPresenceHeartbeatRequest } from "../contract/cli-http-v1.js";
import { DECISION_LIFECYCLE_PROTOCOL_VERSION } from "../protocol/decision-lifecycle.js";
import {
  buildPresenceHeartbeatRequest,
  normalizePresenceHeartbeatResponse,
} from "./presence-heartbeat.js";

describe("daemon presence heartbeat contract", () => {
  it("advertises the exact supported Decision lifecycle protocol additively", () => {
    expect(buildPresenceHeartbeatRequest("session-1")).toEqual({
      sessionId: "session-1",
      decisionLifecycleProtocolVersion: DECISION_LIFECYCLE_PROTOCOL_VERSION,
    });
    expect(DECISION_LIFECYCLE_PROTOCOL_VERSION).toBe(2);
    expect(isPresenceHeartbeatRequest(buildPresenceHeartbeatRequest("session-1"))).toBe(true);
    expect(isPresenceHeartbeatRequest({ sessionId: "session-1" })).toBe(true);
  });

  it("accepts only typed legacy acknowledgement fields", () => {
    expect(normalizePresenceHeartbeatResponse({ accepted: true })).toEqual({ accepted: true });
    expect(
      normalizePresenceHeartbeatResponse({
        accepted: true,
        onlineTeammates: [{ name: "Maya", area: "auth" }],
      }),
    ).toEqual({
      accepted: true,
      onlineTeammates: [{ name: "Maya", area: "auth" }],
    });
    expect(normalizePresenceHeartbeatResponse({ accepted: true, onlineTeammates: [null] })).toBe(
      undefined,
    );
    expect(normalizePresenceHeartbeatResponse({ accepted: true, onlineNames: [1] })).toBe(
      undefined,
    );
    expect(normalizePresenceHeartbeatResponse({ accepted: "true" })).toBe(undefined);
  });
});
