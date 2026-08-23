import type { PresenceHeartbeatRequest } from "../contract/cli-http-v1.js";
import { DECISION_LIFECYCLE_PROTOCOL_VERSION } from "../protocol/decision-lifecycle.js";

/** Additive capability body accepted by lifecycle-aware and legacy servers. */
export function buildPresenceHeartbeatRequest(sessionId: string): PresenceHeartbeatRequest {
  return {
    sessionId,
    decisionLifecycleProtocolVersion: DECISION_LIFECYCLE_PROTOCOL_VERSION,
  };
}
