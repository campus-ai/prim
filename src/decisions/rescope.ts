/**
 * `prim decisions rescope` — replace a Decision's time and/or audience scope
 * without changing its authored content or lifecycle stage.
 *
 * The generated contract is the wire authority. Command output stays split:
 * machine-readable response JSON on stdout, and terminal-safe status/warnings
 * through the injected stderr writer.
 */

import { type CliClient, HttpError, getClient } from "../client.js";
import {
  type DecisionRescopeRequest,
  type DecisionRescopeResponse,
  isCliErrorResponse,
  isDecisionRescopeRequest,
  isDecisionRescopeResponse,
} from "../contract/cli-http-v1.js";
import { terminalSafeLine } from "../lib/terminal-safe.js";
import { renderIdentifier } from "./recent.js";

export const DECISION_RESCOPE_TIMEOUT_MS = 10_000;

export const DECISION_RESCOPE_EXIT = {
  ok: 0,
  auth: 1,
  rejected: 2,
  server: 3,
  notFound: 4,
} as const;

type DecisionRescopeFailureCode =
  | "authentication_required"
  | "organization_unbound"
  | "decision_not_found"
  | "unsupported_server"
  | "rejected"
  | "invalid_request"
  | "invalid_response"
  | "invalid_error_response"
  | "server_error"
  | "transport_error";

interface DecisionRescopeFailure {
  code: DecisionRescopeFailureCode;
  exitCode: number;
  status?: number;
}

export interface DecisionRescopeDependencies {
  getClient: () => CliClient;
  signal: () => AbortSignal;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
}

const defaultDependencies: DecisionRescopeDependencies = {
  getClient,
  signal: () => AbortSignal.timeout(DECISION_RESCOPE_TIMEOUT_MS),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
};

const PATH = "/api/cli/decisions/rescope";
const ORG_UNBOUND_MESSAGE = "CLI token is not bound to an organization";
const DECISION_NOT_FOUND_MESSAGE = "Decision not found";
const OLD_SERVER_NOT_FOUND_MESSAGE = "Not found";

class DecisionRescopeResponseError extends Error {
  constructor() {
    super("Invalid Decision rescope response");
    this.name = "DecisionRescopeResponseError";
  }
}

function projectScope(scope: DecisionRescopeResponse["scope"]): DecisionRescopeResponse["scope"] {
  return {
    location: {
      repository: scope.location.repository,
      directories: scope.location.directories,
      globs: scope.location.globs,
      branches: scope.location.branches,
    },
    time: {
      ...(scope.time.effectiveFrom === undefined
        ? {}
        : { effectiveFrom: scope.time.effectiveFrom }),
      ...(scope.time.effectiveUntil === undefined
        ? {}
        : { effectiveUntil: scope.time.effectiveUntil }),
    },
    users: scope.users,
  };
}

function projectSuccess(response: DecisionRescopeResponse): DecisionRescopeResponse {
  const scope = projectScope(response.scope);
  if (response.outcome === "no_op") {
    return {
      outcome: "no_op",
      stage: response.stage,
      scope,
      ...(response.scopeWarnings === undefined ? {} : { scopeWarnings: response.scopeWarnings }),
    };
  }
  return {
    outcome: "ok",
    decisionId: response.decisionId,
    stage: response.stage,
    scope,
    ...(response.shortId === undefined ? {} : { shortId: response.shortId }),
    ...(response.scopeWarnings === undefined ? {} : { scopeWarnings: response.scopeWarnings }),
  };
}

function failure(
  code: DecisionRescopeFailureCode,
  exitCode: number,
  status?: number,
): DecisionRescopeFailure {
  return { code, exitCode, ...(status === undefined ? {} : { status }) };
}

function classifyHttpError(error: HttpError): DecisionRescopeFailure {
  if (error.status === 401) {
    return failure("authentication_required", DECISION_RESCOPE_EXIT.auth, error.status);
  }
  if (!isCliErrorResponse(error.body)) {
    return failure("invalid_error_response", DECISION_RESCOPE_EXIT.server, error.status);
  }
  if (error.status === 403 && error.body.error === ORG_UNBOUND_MESSAGE) {
    return failure("organization_unbound", DECISION_RESCOPE_EXIT.auth, error.status);
  }
  if (error.status === 404 && error.body.error === DECISION_NOT_FOUND_MESSAGE) {
    return failure("decision_not_found", DECISION_RESCOPE_EXIT.notFound, error.status);
  }
  if (error.status === 404 && error.body.error === OLD_SERVER_NOT_FOUND_MESSAGE) {
    return failure("unsupported_server", DECISION_RESCOPE_EXIT.server, error.status);
  }
  if (error.status >= 400 && error.status < 500) {
    return failure("rejected", DECISION_RESCOPE_EXIT.rejected, error.status);
  }
  return failure("server_error", DECISION_RESCOPE_EXIT.server, error.status);
}

function classifyError(error: unknown): DecisionRescopeFailure {
  if (error instanceof DecisionRescopeResponseError) {
    return failure("invalid_response", DECISION_RESCOPE_EXIT.server);
  }
  if (error instanceof HttpError) return classifyHttpError(error);
  return failure("transport_error", DECISION_RESCOPE_EXIT.server);
}

function formatFailureHuman(result: DecisionRescopeFailure): string {
  switch (result.code) {
    case "authentication_required":
      return "[prim] rescope failed: authentication required; run `prim auth login` and retry.";
    case "organization_unbound":
      return "[prim] rescope failed: an active organization binding is required.";
    case "decision_not_found":
      return "[prim] rescope rejected: Decision not found.";
    case "unsupported_server":
      return "[prim] rescope unavailable: upgrade Primitive before changing Decision scope.";
    case "rejected":
      return "[prim] rescope rejected by the server.";
    case "invalid_request":
      return "[prim] rescope failed: the generated request contract rejected the command input.";
    case "invalid_response":
      return "[prim] rescope failed: the server returned an invalid scope response; no result was accepted.";
    case "invalid_error_response":
      return "[prim] rescope failed: the server returned an invalid error response; no result was accepted.";
    case "server_error":
      return "[prim] rescope failed: the Primitive server could not complete the request.";
    default:
      return "[prim] rescope failed: could not reach the Primitive server.";
  }
}

function writeFailure(
  result: DecisionRescopeFailure,
  dependencies: DecisionRescopeDependencies,
): number {
  dependencies.writeStderr(terminalSafeLine(formatFailureHuman(result)));
  dependencies.writeStdout(
    JSON.stringify(
      {
        ok: false,
        operation: "rescope",
        code: result.code,
        ...(result.status === undefined ? {} : { status: result.status }),
      },
      null,
      2,
    ),
  );
  return result.exitCode;
}

export function formatRescopeHuman(
  request: DecisionRescopeRequest,
  response: DecisionRescopeResponse,
): string {
  const identifier =
    response.outcome === "ok"
      ? renderIdentifier({ id: response.decisionId, shortId: response.shortId })
      : renderIdentifier({ id: request.id });
  const subject = identifier || "the Decision";
  return response.outcome === "no_op"
    ? `[prim] ${subject} already has that scope; nothing to change.`
    : `[prim] rescoped ${subject}.`;
}

export function formatRescopeJson(response: DecisionRescopeResponse): string {
  return JSON.stringify(response, null, 2);
}

export async function rescopeDecision(
  request: DecisionRescopeRequest,
  dependencies: DecisionRescopeDependencies = defaultDependencies,
): Promise<number> {
  if (!isDecisionRescopeRequest(request)) {
    return writeFailure(failure("invalid_request", DECISION_RESCOPE_EXIT.rejected), dependencies);
  }

  try {
    const rawResponse = await dependencies.getClient().post(PATH, request, {
      signal: dependencies.signal(),
    });
    if (!isDecisionRescopeResponse(rawResponse)) {
      throw new DecisionRescopeResponseError();
    }
    const response = projectSuccess(rawResponse);
    for (const warning of response.scopeWarnings ?? []) {
      dependencies.writeStderr(terminalSafeLine(`[prim] rescope warning: ${warning}`));
    }
    dependencies.writeStderr(terminalSafeLine(formatRescopeHuman(request, response)));
    dependencies.writeStdout(formatRescopeJson(response));
    return DECISION_RESCOPE_EXIT.ok;
  } catch (error) {
    return writeFailure(classifyError(error), dependencies);
  }
}
