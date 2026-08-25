import {
  type PresenceHeartbeatRequest,
  type PresenceHeartbeatResponse,
  isPresenceHeartbeatRequest,
  isPresenceHeartbeatResponse,
} from "../contract/cli-http-v1.js";
import type { Teammate } from "../lib/presence.js";
import { DECISION_LIFECYCLE_PROTOCOL_VERSION } from "../protocol/decision-lifecycle.js";

type LegacyPresenceHeartbeatResponse =
  | {
      accepted: true;
      lastHeartbeatAt?: number;
      created?: boolean;
      onlineCount?: number;
      onlineNames?: string[];
      onlineTeammates?: Teammate[];
    }
  | { accepted: false; unavailable?: string };

export type NormalizedPresenceHeartbeatResponse =
  | PresenceHeartbeatResponse
  | LegacyPresenceHeartbeatResponse;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOptionalField(
  value: Record<string, unknown>,
  key: string,
  isValid: (candidate: unknown) => boolean,
): boolean {
  return !Object.hasOwn(value, key) || isValid(value[key]);
}

function isTeammate(value: unknown): value is Teammate {
  return (
    isRecord(value) &&
    typeof value.name === "string" &&
    hasOptionalField(value, "area", (candidate) => typeof candidate === "string") &&
    hasOptionalField(value, "decisionUrl", (candidate) => typeof candidate === "string")
  );
}

function isLegacyHeartbeatResponse(value: Record<string, unknown>): boolean {
  return (
    typeof value.accepted === "boolean" &&
    hasOptionalField(
      value,
      "lastHeartbeatAt",
      (candidate) => typeof candidate === "number" && Number.isFinite(candidate),
    ) &&
    hasOptionalField(value, "created", (candidate) => typeof candidate === "boolean") &&
    hasOptionalField(
      value,
      "onlineCount",
      (candidate) => typeof candidate === "number" && Number.isInteger(candidate) && candidate >= 0,
    ) &&
    hasOptionalField(
      value,
      "onlineNames",
      (candidate) =>
        Array.isArray(candidate) && candidate.every((name) => typeof name === "string"),
    ) &&
    hasOptionalField(
      value,
      "onlineTeammates",
      (candidate) => Array.isArray(candidate) && candidate.every(isTeammate),
    ) &&
    hasOptionalField(value, "unavailable", (candidate) => typeof candidate === "string")
  );
}

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

/**
 * Prefer the generated current response contract, while accepting only the
 * established minimal legacy acknowledgement. Every present known field is
 * checked before it can refresh the daemon's cached presence state.
 */
export function normalizePresenceHeartbeatResponse(
  value: unknown,
): NormalizedPresenceHeartbeatResponse | undefined {
  if (isPresenceHeartbeatResponse(value)) {
    return value;
  }
  return isRecord(value) && isLegacyHeartbeatResponse(value)
    ? (value as LegacyPresenceHeartbeatResponse)
    : undefined;
}
