/**
 * Author-visible Decision lifecycle commands.
 *
 * The generated contract facade is the only wire authority in this module:
 * requests and responses are validated with its runtime validators, and the
 * CLI projects only contract-owned success fields before writing JSON. This
 * keeps additive server fields from becoming an accidental CLI or disclosure
 * surface.
 *
 * AX contract: stdout is one machine-readable JSON document; stderr is one
 * terminal-safe verdict line. A server-confirmed no-op exits 0. Domain
 * rejections exit 2, missing Decisions exit 4, authentication exits 1, and
 * transport/version/contract failures exit 3.
 */

import { type CliClient, HttpError, getClient } from "../client.js";
import {
  type DecisionIdRequest,
  type DecisionStageSuccessResponse,
  type DecisionSupersedeRequest,
  isCliErrorResponse,
  isDecisionIdRequest,
  isDecisionStageSuccessResponse,
  isDecisionSupersedeRequest,
} from "../contract/cli-http-v1.js";
import { terminalSafeLine } from "../lib/terminal-safe.js";
import { renderIdentifier } from "./recent.js";

export type DecisionLifecycleOperation = "publish" | "restore" | "supersede";

export const DECISION_LIFECYCLE_TIMEOUT_MS = 10_000;

export const DECISION_LIFECYCLE_EXIT = {
  ok: 0,
  auth: 1,
  rejected: 2,
  server: 3,
  notFound: 4,
} as const;

export type DecisionLifecycleFailureCode =
  | "authentication_required"
  | "organization_unbound"
  | "not_author"
  | "ambiguous_identifier"
  | "immutable"
  | "illegal_transition"
  | "invalid_replacement"
  | "decision_not_found"
  | "replacement_not_found"
  | "unsupported_server"
  | "rejected"
  | "invalid_request"
  | "invalid_response"
  | "invalid_error_response"
  | "server_error"
  | "transport_error";

interface DecisionLifecycleFailure {
  code: DecisionLifecycleFailureCode;
  exitCode: number;
  status?: number;
}

export interface DecisionLifecycleCommandDependencies {
  getClient: () => CliClient;
  signal: () => AbortSignal;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
}

const defaultDependencies: DecisionLifecycleCommandDependencies = {
  getClient,
  signal: () => AbortSignal.timeout(DECISION_LIFECYCLE_TIMEOUT_MS),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
};

const EXPECTED_STAGE = {
  publish: "provisional",
  restore: "draft",
  supersede: "superseded",
} as const satisfies Record<DecisionLifecycleOperation, DecisionStageSuccessResponse["stage"]>;

const PATH = {
  publish: "/api/cli/decisions/publish",
  restore: "/api/cli/decisions/restore",
  supersede: "/api/cli/decisions/supersede",
} as const satisfies Record<DecisionLifecycleOperation, string>;

const PAST_PARTICIPLE = {
  publish: "published",
  restore: "restored",
  supersede: "superseded",
} as const satisfies Record<DecisionLifecycleOperation, string>;

const ORG_UNBOUND_MESSAGE = "CLI token is not bound to an organization";
const NOT_AUTHOR_MESSAGE = "Only the decision's author can perform this action";
const AMBIGUOUS_MESSAGE =
  "shortId is ambiguous in this organization; retry with the full decision id";
const DECISION_NOT_FOUND_MESSAGE = "Decision not found";
const REPLACEMENT_NOT_FOUND_MESSAGE = "Replacement decision not found";
const SELF_REPLACEMENT_MESSAGE = "A decision cannot supersede itself";
const OLD_SERVER_NOT_FOUND_MESSAGE = "Not found";
const STAGE_NAME = "(?:draft|provisional|adopted|superseded|abandoned)";
const IMMUTABLE_MESSAGE = new RegExp(
  `^An ${STAGE_NAME} decision is immutable — supersede it to change it$`,
  "u",
);
const ILLEGAL_TRANSITION_MESSAGE = new RegExp(
  `^Cannot move (?:a|an) ${STAGE_NAME} decision to ${STAGE_NAME}$`,
  "u",
);

class DecisionLifecycleResponseError extends Error {
  constructor() {
    super("Invalid Decision lifecycle response");
    this.name = "DecisionLifecycleResponseError";
  }
}

type LifecycleWireRequest = DecisionIdRequest | DecisionSupersedeRequest;

function projectSuccess(response: DecisionStageSuccessResponse): DecisionStageSuccessResponse {
  if (response.outcome === "no_op") {
    return { outcome: response.outcome, stage: response.stage };
  }
  return {
    outcome: response.outcome,
    decisionId: response.decisionId,
    ...(response.shortId === undefined ? {} : { shortId: response.shortId }),
    stage: response.stage,
  };
}

function safeRequestedIdentifier(value: string, fallback: string): string {
  return renderIdentifier({ id: value }) || fallback;
}

function formatSuccessHuman(
  operation: DecisionLifecycleOperation,
  request: LifecycleWireRequest,
  response: DecisionStageSuccessResponse,
): string {
  if (response.outcome === "no_op") {
    const identifier = safeRequestedIdentifier(request.id, "the Decision");
    return `[prim] ${identifier} is already ${response.stage}; nothing to change.`;
  }

  const identifier =
    renderIdentifier({ id: response.decisionId, shortId: response.shortId }) || "the Decision";
  if (operation === "publish") {
    return `[prim] ${identifier} published as ${response.stage}.`;
  }
  if (operation === "restore") {
    return `[prim] ${identifier} restored as a private draft.`;
  }

  const replacement = safeRequestedIdentifier(
    (request as DecisionSupersedeRequest).by,
    "the replacement Decision",
  );
  return `[prim] ${identifier} superseded by ${replacement}.`;
}

function failure(
  code: DecisionLifecycleFailureCode,
  exitCode: number,
  status?: number,
): DecisionLifecycleFailure {
  return { code, exitCode, ...(status === undefined ? {} : { status }) };
}

function classifyHttpError(error: HttpError): DecisionLifecycleFailure {
  if (error.status === 401) {
    return failure("authentication_required", DECISION_LIFECYCLE_EXIT.auth, error.status);
  }
  if (!isCliErrorResponse(error.body)) {
    return failure("invalid_error_response", DECISION_LIFECYCLE_EXIT.server, error.status);
  }

  const message = error.body.error;
  if (error.status === 403 && message === ORG_UNBOUND_MESSAGE) {
    return failure("organization_unbound", DECISION_LIFECYCLE_EXIT.auth, error.status);
  }
  if (error.status === 403 && message === NOT_AUTHOR_MESSAGE) {
    return failure("not_author", DECISION_LIFECYCLE_EXIT.rejected, error.status);
  }
  if (error.status === 409 && message === AMBIGUOUS_MESSAGE) {
    return failure("ambiguous_identifier", DECISION_LIFECYCLE_EXIT.rejected, error.status);
  }
  if (error.status === 409 && IMMUTABLE_MESSAGE.test(message)) {
    return failure("immutable", DECISION_LIFECYCLE_EXIT.rejected, error.status);
  }
  if (error.status === 409 && ILLEGAL_TRANSITION_MESSAGE.test(message)) {
    return failure("illegal_transition", DECISION_LIFECYCLE_EXIT.rejected, error.status);
  }
  if (error.status === 400 && message === SELF_REPLACEMENT_MESSAGE) {
    return failure("invalid_replacement", DECISION_LIFECYCLE_EXIT.rejected, error.status);
  }
  if (error.status === 404 && message === DECISION_NOT_FOUND_MESSAGE) {
    return failure("decision_not_found", DECISION_LIFECYCLE_EXIT.notFound, error.status);
  }
  if (error.status === 404 && message === REPLACEMENT_NOT_FOUND_MESSAGE) {
    return failure("replacement_not_found", DECISION_LIFECYCLE_EXIT.notFound, error.status);
  }
  if (error.status === 404 && message === OLD_SERVER_NOT_FOUND_MESSAGE) {
    return failure("unsupported_server", DECISION_LIFECYCLE_EXIT.server, error.status);
  }
  if (error.status >= 400 && error.status < 500) {
    return failure("rejected", DECISION_LIFECYCLE_EXIT.rejected, error.status);
  }
  return failure("server_error", DECISION_LIFECYCLE_EXIT.server, error.status);
}

function classifyError(error: unknown): DecisionLifecycleFailure {
  if (error instanceof DecisionLifecycleResponseError) {
    return failure("invalid_response", DECISION_LIFECYCLE_EXIT.server);
  }
  if (error instanceof HttpError) {
    return classifyHttpError(error);
  }
  return failure("transport_error", DECISION_LIFECYCLE_EXIT.server);
}

function operationVerb(operation: DecisionLifecycleOperation): string {
  return operation;
}

function formatFailureHuman(
  operation: DecisionLifecycleOperation,
  result: DecisionLifecycleFailure,
): string {
  const verb = operationVerb(operation);
  switch (result.code) {
    case "authentication_required":
      return `[prim] ${verb} failed: authentication required; run \`prim auth login\` and retry.`;
    case "organization_unbound":
      return `[prim] ${verb} failed: an active organization binding is required.`;
    case "not_author":
      return `[prim] ${verb} rejected: only the Decision's author can ${verb} it.`;
    case "ambiguous_identifier":
      return `[prim] ${verb} rejected: a Decision identifier is ambiguous; retry with full Decision IDs.`;
    case "immutable":
      return `[prim] ${verb} rejected: this Decision is immutable; supersede it to change it.`;
    case "illegal_transition":
      return `[prim] ${verb} rejected: the Decision's current lifecycle stage cannot be ${PAST_PARTICIPLE[operation]}.`;
    case "invalid_replacement":
      return "[prim] supersede rejected: a Decision cannot supersede itself.";
    case "decision_not_found":
      return `[prim] ${verb} rejected: Decision not found.`;
    case "replacement_not_found":
      return "[prim] supersede rejected: replacement Decision not found.";
    case "unsupported_server":
      return `[prim] ${verb} unavailable: this Primitive server does not support this Decision lifecycle operation; upgrade the server before retrying.`;
    case "rejected":
      return `[prim] ${verb} rejected by the server.`;
    case "invalid_request":
      return `[prim] ${verb} failed: the generated request contract rejected the command input.`;
    case "invalid_response":
      return `[prim] ${verb} failed: the server returned an invalid lifecycle response; no result was accepted.`;
    case "invalid_error_response":
      return `[prim] ${verb} failed: the server returned an invalid error response; no result was accepted.`;
    case "server_error":
      return `[prim] ${verb} failed: the Primitive server could not complete the request.`;
    default:
      return `[prim] ${verb} failed: could not reach the Primitive server.`;
  }
}

function writeFailure(
  operation: DecisionLifecycleOperation,
  result: DecisionLifecycleFailure,
  dependencies: DecisionLifecycleCommandDependencies,
): number {
  dependencies.writeStderr(terminalSafeLine(formatFailureHuman(operation, result)));
  dependencies.writeStdout(
    JSON.stringify(
      {
        ok: false,
        operation,
        code: result.code,
        ...(result.status === undefined ? {} : { status: result.status }),
      },
      null,
      2,
    ),
  );
  return result.exitCode;
}

async function executeLifecycle(
  operation: DecisionLifecycleOperation,
  request: LifecycleWireRequest,
  dependencies: DecisionLifecycleCommandDependencies,
): Promise<number> {
  const requestIsValid =
    operation === "supersede" ? isDecisionSupersedeRequest(request) : isDecisionIdRequest(request);
  if (!requestIsValid) {
    return writeFailure(
      operation,
      failure("invalid_request", DECISION_LIFECYCLE_EXIT.rejected),
      dependencies,
    );
  }

  try {
    const rawResponse = await dependencies.getClient().post(PATH[operation], request, {
      signal: dependencies.signal(),
    });
    if (
      !isDecisionStageSuccessResponse(rawResponse) ||
      rawResponse.stage !== EXPECTED_STAGE[operation]
    ) {
      throw new DecisionLifecycleResponseError();
    }
    const response = projectSuccess(rawResponse);
    dependencies.writeStderr(terminalSafeLine(formatSuccessHuman(operation, request, response)));
    dependencies.writeStdout(JSON.stringify(response, null, 2));
    return DECISION_LIFECYCLE_EXIT.ok;
  } catch (error) {
    return writeFailure(operation, classifyError(error), dependencies);
  }
}

export function publishDecision(
  id: string,
  dependencies: DecisionLifecycleCommandDependencies = defaultDependencies,
): Promise<number> {
  const request: DecisionIdRequest = { id };
  return executeLifecycle("publish", request, dependencies);
}

export function restoreDecision(
  id: string,
  dependencies: DecisionLifecycleCommandDependencies = defaultDependencies,
): Promise<number> {
  const request: DecisionIdRequest = { id };
  return executeLifecycle("restore", request, dependencies);
}

export function supersedeDecision(
  id: string,
  by: string,
  dependencies: DecisionLifecycleCommandDependencies = defaultDependencies,
): Promise<number> {
  const request: DecisionSupersedeRequest = { id, by };
  return executeLifecycle("supersede", request, dependencies);
}
