import type { PresenceHeartbeatRequest } from "../contract/cli-http-v1.js";
import { isPresenceHeartbeatRequest } from "../contract/cli-http-v1.js";
import { DECISION_LIFECYCLE_PROTOCOL_VERSION } from "../protocol/decision-lifecycle.js";

/** Additive capability body accepted by lifecycle-aware and legacy servers. */
export function buildPresenceHeartbeatRequest(
  sessionId: string,
  clientInstanceId: string,
): PresenceHeartbeatRequest {
  const request = {
    sessionId,
    clientInstanceId,
    decisionLifecycleProtocolVersion: DECISION_LIFECYCLE_PROTOCOL_VERSION,
  };
  if (!isPresenceHeartbeatRequest(request)) {
    throw new Error("presence heartbeat identity or session is invalid");
  }
  return request;
}
