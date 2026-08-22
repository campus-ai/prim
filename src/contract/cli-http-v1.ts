/** Stable facade over the generated request-core contract. */

import type {
  CliErrorResponse,
  DurableMoveIngestResponse,
  FeedbackAckRequest,
  FeedbackLeaseRequest,
  MoveIngestRequest,
  PreflightRequestV3,
  RepositoryBindRequest,
} from "../generated/cli-http-v1.types.js";
import {
  isCliErrorResponse,
  isDurableMoveIngestResponse,
  isFeedbackAckRequestStructure,
  isFeedbackLeaseRequestStructure,
  isMoveIngestRequest,
  isPreflightRequestV3Structure,
  isRepositoryBindRequest,
} from "../generated/cli-http-v1.validators.js";

export type {
  CliErrorResponse,
  DurableMoveIngestResponse,
  FeedbackAckRequest,
  FeedbackLeaseRequest,
  MoveIngestRequest,
  PreflightRequestV3,
  RepositoryBindRequest,
};

export {
  isCliErrorResponse,
  isDurableMoveIngestResponse,
  isFeedbackAckRequestStructure,
  isFeedbackLeaseRequestStructure,
  isMoveIngestRequest,
  isPreflightRequestV3Structure,
  isRepositoryBindRequest,
};

const MAX_REPOSITORY_PATH_CHARS = 4_096;
const MAX_PROPOSAL_BYTES = 6_144;
const MAX_FEEDBACK_SESSION_ID_CHARS = 256;
const MAX_FEEDBACK_EVENT_ID_CHARS = 128;
const CANONICAL_WORKSPACE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// biome-ignore lint/suspicious/noControlCharactersInRegex: wire paths reject C0 and DEL.
const PATH_CONTROL = /[\x00-\x1f\x7f]/u;

function isCanonicalRepositoryPath(path: string): boolean {
  return (
    path.length > 0 &&
    path.length <= MAX_REPOSITORY_PATH_CHARS &&
    !path.startsWith("/") &&
    !path.includes("\\") &&
    !PATH_CONTROL.test(path) &&
    path.split("/").every((segment) => !["", ".", ".."].includes(segment))
  );
}

function isBidiControl(codePoint: number): boolean {
  return (
    codePoint === 0x06_1c ||
    codePoint === 0x20_0e ||
    codePoint === 0x20_0f ||
    (codePoint >= 0x20_2a && codePoint <= 0x20_2e) ||
    (codePoint >= 0x20_66 && codePoint <= 0x20_69)
  );
}

function hasUnsafeFeedbackIdentifierCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd8_00 && codePoint <= 0xdf_ff) ||
      isBidiControl(codePoint)
    );
  });
}

/**
 * Validate the canonical outbound V3 request, including every named semantic
 * refinement in the server artifact. The server-only
 * `degrade_invalid_rollout_fields` transform is deliberately not mirrored:
 * this producer emits canonical annotations and never parses untrusted ones.
 */
export function isPreflightRequestV3(value: unknown): value is PreflightRequestV3 {
  if (!isPreflightRequestV3Structure(value)) {
    return false;
  }
  return (
    value.paths.every(isCanonicalRepositoryPath) &&
    new Set(value.paths).size === value.paths.length &&
    (value.coverage !== "complete" || value.paths.length > 0) &&
    new TextEncoder().encode(value.proposal).length <= MAX_PROPOSAL_BYTES
  );
}

export function isFeedbackLeaseRequest(value: unknown): value is FeedbackLeaseRequest {
  if (!isFeedbackLeaseRequestStructure(value)) {
    return false;
  }
  return (
    CANONICAL_WORKSPACE_ID.test(value.workspaceId) &&
    value.currentSessionId.length > 0 &&
    value.currentSessionId.length <= MAX_FEEDBACK_SESSION_ID_CHARS &&
    !hasUnsafeFeedbackIdentifierCharacter(value.currentSessionId)
  );
}

export function isFeedbackAckRequest(value: unknown): value is FeedbackAckRequest {
  if (!isFeedbackAckRequestStructure(value) || !CANONICAL_WORKSPACE_ID.test(value.workspaceId)) {
    return false;
  }
  const eventIds = value.deliveries.map(({ eventId }) => eventId);
  return (
    eventIds.every(
      (eventId) =>
        eventId.length > 0 &&
        eventId.length <= MAX_FEEDBACK_EVENT_ID_CHARS &&
        !hasUnsafeFeedbackIdentifierCharacter(eventId),
    ) && new Set(eventIds).size === eventIds.length
  );
}
