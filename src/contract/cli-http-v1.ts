/** Stable facade over the generated critical-path contract. */

import type {
  CliAuthStatusResponse,
  DecisionCreateRequest,
  DecisionsRecentResponse,
  FeedbackAckRequest,
  FeedbackAckResponse,
  FeedbackLeaseRequest,
  FeedbackLeaseResponse,
  GitHubInstallIntentStatusResponse,
  PreflightRequestV3,
  WorkosConnectDeviceConfigurationSuccess,
} from "../generated/cli-http-v1.types.js";
import {
  isCliAuthStatusResponse,
  isCliErrorResponse,
  isDecisionCascadeResponse,
  isDecisionConfirmRequest,
  isDecisionConfirmSuccessResponse,
  isDecisionCreateRequestStructure,
  isDecisionCreateResponse,
  isDecisionDetailResponse,
  isDecisionEditRequest,
  isDecisionIdRequest,
  isDecisionRelateRequest,
  isDecisionRelateSuccessResponse,
  isDecisionStageSuccessResponse,
  isDecisionSupersedeRequest,
  isDecisionsAffectingResponse,
  isDecisionsRecentResponseStructure,
  isDurableMoveIngestResponse,
  isFeedbackAckRequestStructure,
  isFeedbackAckResponseStructure,
  isFeedbackLeaseRequestStructure,
  isFeedbackLeaseResponseStructure,
  isFeedbackStatusResponse,
  isGitHubInstallIntentStartErrorResponse,
  isGitHubInstallIntentStartResponse,
  isGitHubInstallIntentStatusErrorResponse,
  isGitHubInstallIntentStatusRequest,
  isGitHubInstallIntentStatusResponseStructure,
  isMoveIngestRequest,
  isPreflightRequestV3Structure,
  isPreflightResponseV3,
  isPresenceHeartbeatRequest,
  isPresenceHeartbeatResponse,
  isRepositoryBindRequest,
  isRepositoryBindResponse,
  isUserApiKeyListRequest,
  isUserApiKeyListResponse,
  isUserApiKeyMetadata,
  isUserApiKeyMintRequest,
  isUserApiKeyMintResponse,
  isUserApiKeyRevokeRequest,
  isUserApiKeyRevokeResponse,
  isWorkosConnectDeviceConfigurationDisabled,
  isWorkosConnectDeviceConfigurationError,
  isWorkosConnectDeviceConfigurationSuccessStructure,
  isWorkosConnectDeviceConfigurationUnavailable,
} from "../generated/cli-http-v1.validators.js";

export type * from "../generated/cli-http-v1.types.js";

export {
  isCliAuthStatusResponse,
  isCliErrorResponse,
  isDecisionCascadeResponse,
  isDecisionConfirmRequest,
  isDecisionConfirmSuccessResponse,
  isDecisionCreateRequestStructure,
  isDecisionCreateResponse,
  isDecisionDetailResponse,
  isDecisionEditRequest,
  isDecisionIdRequest,
  isDecisionRelateRequest,
  isDecisionRelateSuccessResponse,
  isDecisionStageSuccessResponse,
  isDecisionSupersedeRequest,
  isDecisionsAffectingResponse,
  isDecisionsRecentResponseStructure,
  isDurableMoveIngestResponse,
  isFeedbackAckRequestStructure,
  isFeedbackAckResponseStructure,
  isFeedbackLeaseRequestStructure,
  isFeedbackLeaseResponseStructure,
  isFeedbackStatusResponse,
  isGitHubInstallIntentStartErrorResponse,
  isGitHubInstallIntentStartResponse,
  isGitHubInstallIntentStatusErrorResponse,
  isGitHubInstallIntentStatusRequest,
  isGitHubInstallIntentStatusResponseStructure,
  isMoveIngestRequest,
  isPreflightRequestV3Structure,
  isPreflightResponseV3,
  isPresenceHeartbeatRequest,
  isPresenceHeartbeatResponse,
  isRepositoryBindRequest,
  isRepositoryBindResponse,
  isUserApiKeyListRequest,
  isUserApiKeyListResponse,
  isUserApiKeyMetadata,
  isUserApiKeyMintRequest,
  isUserApiKeyMintResponse,
  isUserApiKeyRevokeRequest,
  isUserApiKeyRevokeResponse,
  isWorkosConnectDeviceConfigurationDisabled,
  isWorkosConnectDeviceConfigurationError,
  isWorkosConnectDeviceConfigurationSuccessStructure,
  isWorkosConnectDeviceConfigurationUnavailable,
};

const MAX_REPOSITORY_PATH_CHARS = 4_096;
const MAX_PROPOSAL_BYTES = 6_144;
const MAX_FEEDBACK_SESSION_ID_CHARS = 256;
const MAX_FEEDBACK_EVENT_ID_CHARS = 128;
const MAX_FEEDBACK_DECISION_ID_CHARS = 128;
const WORKOS_CONNECT_DEVICE_SCOPES = ["openid", "profile", "email", "offline_access"] as const;
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

function isSafeFeedbackDecisionId(value: string | undefined): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_FEEDBACK_DECISION_ID_CHARS &&
    !hasUnsafeFeedbackIdentifierCharacter(value)
  );
}

function isCanonicalHttpsOrigin(value: string): boolean {
  if (value.trim() !== value) {
    return false;
  }
  try {
    const parsed = new URL(value);
    return (
      parsed.protocol === "https:" &&
      parsed.username === "" &&
      parsed.password === "" &&
      parsed.origin === value &&
      parsed.pathname === "/" &&
      parsed.search === "" &&
      parsed.hash === ""
    );
  } catch {
    return false;
  }
}

/**
 * Validate the server-owned Connect discovery semantics that JSON Schema
 * cannot express: canonical HTTPS issuer and the exact public scope order.
 */
export function isWorkosConnectDeviceConfigurationSuccess(
  value: unknown,
): value is WorkosConnectDeviceConfigurationSuccess {
  return (
    isWorkosConnectDeviceConfigurationSuccessStructure(value) &&
    isCanonicalHttpsOrigin(value.issuer) &&
    value.default_scopes.every((scope, index) => scope === WORKOS_CONNECT_DEVICE_SCOPES[index])
  );
}

/**
 * Validate the canonical outbound V3 request, including every producer-side
 * refinement. The server-only rollout-field degradation transform is not
 * mirrored: this producer emits canonical annotations.
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

/**
 * The server degrades invalid optional rollout fields instead of rejecting the
 * request. CLI producers already emit the canonical subset, so structural
 * validation is the correct non-mutating producer check.
 */
export function isDecisionCreateRequest(value: unknown): value is DecisionCreateRequest {
  return isDecisionCreateRequestStructure(value);
}

export function isFeedbackLeaseResponse(value: unknown): value is FeedbackLeaseResponse {
  if (!isFeedbackLeaseResponseStructure(value)) {
    return false;
  }
  if (value.status !== "leased") {
    return true;
  }
  const eventIds = value.events.map(({ eventId }) => eventId);
  if (new Set(eventIds).size !== eventIds.length) {
    return false;
  }
  if (value.protocolVersion === 1) {
    return value.events.every(
      ({ kind, decisionId }) => kind !== "publish_prompt" && decisionId === undefined,
    );
  }
  return value.events.every(({ kind, decisionId }) => {
    if (kind === "publish_prompt") {
      return isSafeFeedbackDecisionId(decisionId);
    }
    return kind === "confirm_prompt" && decisionId === undefined;
  });
}

export function isFeedbackAckResponse(value: unknown): value is FeedbackAckResponse {
  if (!isFeedbackAckResponseStructure(value)) {
    return false;
  }
  return (
    value.status !== "acked" ||
    new Set(value.acknowledgedEventIds).size === value.acknowledgedEventIds.length
  );
}

export function isDecisionsRecentResponse(value: unknown): value is DecisionsRecentResponse {
  if (!isDecisionsRecentResponseStructure(value)) {
    return false;
  }
  const authorFields = [value.authorHasDecisions, value.windowTotal, value.windowTotalCapped];
  if (value.unavailable !== undefined) {
    return (
      value.decisions.length === 0 &&
      value.viewerHasDecisions === undefined &&
      value.author === undefined &&
      authorFields.every((field) => field === undefined)
    );
  }
  if (value.viewerHasDecisions === undefined) {
    return false;
  }
  const hasEveryAuthorField =
    value.author !== undefined && authorFields.every((field) => field !== undefined);
  const hasNoAuthorField =
    value.author === undefined && authorFields.every((field) => field === undefined);
  return hasEveryAuthorField || hasNoAuthorField;
}

/**
 * Validate the server-owned install intent lifecycle rules that JSON Schema
 * cannot express across union-member fields.
 */
export function isGitHubInstallIntentStatusResponse(
  value: unknown,
): value is GitHubInstallIntentStatusResponse {
  if (!isGitHubInstallIntentStatusResponseStructure(value)) {
    return false;
  }
  switch (value.status) {
    case "claimed":
      return value.leaseExpiresAt <= value.expiresAt;
    case "consumed":
      return (
        value.repositoryCount === value.adminRepositoryCount + value.nonAdminRepositoryCount &&
        value.completedAt <= value.expiresAt
      );
    case "expired":
      return value.closedAt >= value.expiresAt;
    case "cancelled":
      return value.closedAt <= value.expiresAt;
    case "failed_terminal":
      return value.failureCode === "claim_lease_expired" || value.closedAt <= value.expiresAt;
    case "pending":
      return true;
  }
}

/** Complete definition registry used by shared cross-repository fixtures. */
export const cliHttpV1Validators = {
  CliAuthStatusResponse: isCliAuthStatusResponse,
  CliErrorResponse: isCliErrorResponse,
  DecisionCascadeResponse: isDecisionCascadeResponse,
  DecisionConfirmRequest: isDecisionConfirmRequest,
  DecisionConfirmSuccessResponse: isDecisionConfirmSuccessResponse,
  DecisionCreateRequest: isDecisionCreateRequest,
  DecisionCreateResponse: isDecisionCreateResponse,
  DecisionDetailResponse: isDecisionDetailResponse,
  DecisionEditRequest: isDecisionEditRequest,
  DecisionIdRequest: isDecisionIdRequest,
  DecisionRelateRequest: isDecisionRelateRequest,
  DecisionRelateSuccessResponse: isDecisionRelateSuccessResponse,
  DecisionStageSuccessResponse: isDecisionStageSuccessResponse,
  DecisionSupersedeRequest: isDecisionSupersedeRequest,
  DecisionsAffectingResponse: isDecisionsAffectingResponse,
  DecisionsRecentResponse: isDecisionsRecentResponse,
  DurableMoveIngestResponse: isDurableMoveIngestResponse,
  FeedbackAckRequest: isFeedbackAckRequest,
  FeedbackAckResponse: isFeedbackAckResponse,
  FeedbackLeaseRequest: isFeedbackLeaseRequest,
  FeedbackLeaseResponse: isFeedbackLeaseResponse,
  FeedbackStatusResponse: isFeedbackStatusResponse,
  GitHubInstallIntentStartErrorResponse: isGitHubInstallIntentStartErrorResponse,
  GitHubInstallIntentStartResponse: isGitHubInstallIntentStartResponse,
  GitHubInstallIntentStatusErrorResponse: isGitHubInstallIntentStatusErrorResponse,
  GitHubInstallIntentStatusRequest: isGitHubInstallIntentStatusRequest,
  GitHubInstallIntentStatusResponse: isGitHubInstallIntentStatusResponse,
  MoveIngestRequest: isMoveIngestRequest,
  PreflightRequestV3: isPreflightRequestV3,
  PreflightResponseV3: isPreflightResponseV3,
  PresenceHeartbeatRequest: isPresenceHeartbeatRequest,
  PresenceHeartbeatResponse: isPresenceHeartbeatResponse,
  RepositoryBindRequest: isRepositoryBindRequest,
  RepositoryBindResponse: isRepositoryBindResponse,
  UserApiKeyListRequest: isUserApiKeyListRequest,
  UserApiKeyListResponse: isUserApiKeyListResponse,
  UserApiKeyMetadata: isUserApiKeyMetadata,
  UserApiKeyMintRequest: isUserApiKeyMintRequest,
  UserApiKeyMintResponse: isUserApiKeyMintResponse,
  UserApiKeyRevokeRequest: isUserApiKeyRevokeRequest,
  UserApiKeyRevokeResponse: isUserApiKeyRevokeResponse,
  WorkosConnectDeviceConfigurationDisabled: isWorkosConnectDeviceConfigurationDisabled,
  WorkosConnectDeviceConfigurationError: isWorkosConnectDeviceConfigurationError,
  WorkosConnectDeviceConfigurationSuccess: isWorkosConnectDeviceConfigurationSuccess,
  WorkosConnectDeviceConfigurationUnavailable: isWorkosConnectDeviceConfigurationUnavailable,
} as const satisfies Record<string, (value: unknown) => boolean>;

export type CliHttpV1DefinitionName = keyof typeof cliHttpV1Validators;
