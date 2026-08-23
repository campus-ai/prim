/**
 * WorkOS user API-key management for the authenticated CLI user.
 *
 * Every operation uses a pinned bearer generation. In particular, mint never
 * retries after an HTTP response because a lost provider response is
 * indistinguishable from a successfully-created one-time secret.
 */

import { randomBytes } from "node:crypto";
import {
  type CliManagementClient,
  CliManagementResponseError,
  HttpError,
  getPinnedManagementClient,
} from "../client.js";
import {
  type UserApiKeyListRequest,
  type UserApiKeyListResponse,
  type UserApiKeyMetadata,
  type UserApiKeyMintRequest,
  type UserApiKeyMintResponse,
  type UserApiKeyRevokeRequest,
  type UserApiKeyRevokeResponse,
  isCliErrorResponse,
  isUserApiKeyListRequest,
  isUserApiKeyListResponse,
  isUserApiKeyMintRequest,
  isUserApiKeyMintResponse,
  isUserApiKeyRevokeRequest,
  isUserApiKeyRevokeResponse,
} from "../contract/cli-http-v1.js";
import { terminalSafeLine } from "../lib/terminal-safe.js";

export type UserApiKeyOperation = "mint" | "list" | "revoke";

export const USER_API_KEY_TIMEOUT_MS = 10_000;
export const USER_API_KEY_EXIT = {
  ok: 0,
  auth: 1,
  rejected: 2,
  server: 3,
  notFound: 4,
} as const;

export type UserApiKeyFailureCode =
  | "authentication_required"
  | "workos_session_required"
  | "current_membership_required"
  | "invalid_input"
  | "api_key_not_found"
  | "operation_uncertain"
  | "unsupported_server"
  | "rejected"
  | "invalid_response"
  | "invalid_error_response"
  | "server_error"
  | "transport_error";

type UserApiKeyFailure = Readonly<{
  code: UserApiKeyFailureCode;
  exitCode: number;
  status?: number;
}>;

export interface UserApiKeyDependencies {
  getClient: () => Promise<CliManagementClient>;
  requestId: () => string;
  signal: () => AbortSignal;
  writeStdout: (value: string) => void;
  writeStderr: (value: string) => void;
}

const defaultDependencies: UserApiKeyDependencies = {
  getClient: () =>
    getPinnedManagementClient({ signal: AbortSignal.timeout(USER_API_KEY_TIMEOUT_MS) }),
  requestId: () => randomBytes(32).toString("hex"),
  signal: () => AbortSignal.timeout(USER_API_KEY_TIMEOUT_MS),
  writeStdout: (value) => console.log(value),
  writeStderr: (value) => console.error(value),
};

const API_KEY_ID = /^api_key_[A-Za-z0-9_-]+$/u;
const API_KEY_ID_MAX_LENGTH = 256;
const MINT_PATH = "/api/cli/auth/api-keys";

function exactApiKeyId(value: string): boolean {
  return value.length >= 9 && value.length <= API_KEY_ID_MAX_LENGTH && API_KEY_ID.test(value);
}

function projectMetadata(value: UserApiKeyMetadata): UserApiKeyMetadata {
  return {
    id: value.id,
    name: value.name,
    obfuscatedValue: value.obfuscatedValue,
    permissions: [...value.permissions],
    lastUsedAt: value.lastUsedAt,
    expiresAt: value.expiresAt,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}

function projectMint(value: UserApiKeyMintResponse): UserApiKeyMintResponse {
  return { apiKey: projectMetadata(value.apiKey), secret: value.secret };
}

function projectList(value: UserApiKeyListResponse): UserApiKeyListResponse {
  return {
    apiKeys: value.apiKeys.map(projectMetadata),
    nextCursor: value.nextCursor,
  };
}

function failure(
  code: UserApiKeyFailureCode,
  exitCode: number,
  status?: number,
): UserApiKeyFailure {
  return { code, exitCode, ...(status === undefined ? {} : { status }) };
}

function classifyHttpError(error: HttpError): UserApiKeyFailure {
  if (error.status === 401) {
    return failure("authentication_required", USER_API_KEY_EXIT.auth, error.status);
  }
  if (!isCliErrorResponse(error.body)) {
    return failure("invalid_error_response", USER_API_KEY_EXIT.server, error.status);
  }
  const code = error.body.error;
  if (error.status === 403 && code === "workos_session_required") {
    return failure("workos_session_required", USER_API_KEY_EXIT.auth, error.status);
  }
  if (error.status === 403 && code === "current_membership_required") {
    return failure("current_membership_required", USER_API_KEY_EXIT.auth, error.status);
  }
  if (error.status === 404 && code === "api_key_not_found") {
    return failure("api_key_not_found", USER_API_KEY_EXIT.notFound, error.status);
  }
  if (error.status === 404 && code === "Not found") {
    return failure("unsupported_server", USER_API_KEY_EXIT.server, error.status);
  }
  if (error.status === 409 && code === "operation_uncertain") {
    return failure("operation_uncertain", USER_API_KEY_EXIT.server, error.status);
  }
  if (error.status >= 400 && error.status < 500) {
    return failure("rejected", USER_API_KEY_EXIT.rejected, error.status);
  }
  return failure("server_error", USER_API_KEY_EXIT.server, error.status);
}

function classifyError(error: unknown): UserApiKeyFailure {
  if (error instanceof CliManagementResponseError) {
    return failure("invalid_response", USER_API_KEY_EXIT.server);
  }
  if (error instanceof HttpError) return classifyHttpError(error);
  return failure("transport_error", USER_API_KEY_EXIT.server);
}

function failureMessage(operation: UserApiKeyOperation, result: UserApiKeyFailure): string {
  switch (result.code) {
    case "authentication_required":
      return `[prim] API-key ${operation} failed: run \`prim auth login\` and retry.`;
    case "workos_session_required":
      return `[prim] API-key ${operation} requires a WorkOS user session; API keys and service tokens cannot manage user keys.`;
    case "current_membership_required":
      return `[prim] API-key ${operation} failed: current organization membership is required.`;
    case "invalid_input":
      return `[prim] API-key ${operation} rejected invalid command input.`;
    case "api_key_not_found":
      return "[prim] API-key revoke rejected: that key was not found for the current user and organization.";
    case "operation_uncertain":
      return `[prim] API-key ${operation} is uncertain; do not retry automatically. List keys and reconcile first.`;
    case "unsupported_server":
      return `[prim] API-key ${operation} requires a newer Primitive server.`;
    case "rejected":
      return `[prim] API-key ${operation} was rejected by the server.`;
    case "invalid_response":
      return `[prim] API-key ${operation} failed: the server returned an invalid response.`;
    case "invalid_error_response":
      return `[prim] API-key ${operation} failed: the server returned an invalid error response.`;
    case "server_error":
      return `[prim] API-key ${operation} failed: the server could not complete the operation.`;
    default:
      return `[prim] API-key ${operation} failed: could not reach the Primitive server.`;
  }
}

function writeFailure(
  operation: UserApiKeyOperation,
  result: UserApiKeyFailure,
  dependencies: UserApiKeyDependencies,
): number {
  dependencies.writeStderr(terminalSafeLine(failureMessage(operation, result)));
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

export async function mintUserApiKey(
  input: Readonly<{ name: string; expiresAt?: number }>,
  dependencies: UserApiKeyDependencies = defaultDependencies,
): Promise<number> {
  const request: UserApiKeyMintRequest = {
    requestId: dependencies.requestId(),
    name: input.name,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
  if (!isUserApiKeyMintRequest(request)) {
    return writeFailure("mint", failure("invalid_input", USER_API_KEY_EXIT.rejected), dependencies);
  }
  try {
    const client = await dependencies.getClient();
    const raw = await client.post(MINT_PATH, request, { signal: dependencies.signal() });
    if (
      !isUserApiKeyMintResponse(raw) ||
      raw.apiKey.name !== request.name ||
      (request.expiresAt !== undefined && raw.apiKey.expiresAt !== request.expiresAt)
    ) {
      return writeFailure(
        "mint",
        failure("invalid_response", USER_API_KEY_EXIT.server),
        dependencies,
      );
    }
    const response = projectMint(raw);
    dependencies.writeStderr(
      `[prim] API key ${response.apiKey.id} minted. Save the secret from stdout now; it will not be shown again.`,
    );
    dependencies.writeStdout(JSON.stringify(response, null, 2));
    return USER_API_KEY_EXIT.ok;
  } catch (error) {
    return writeFailure("mint", classifyError(error), dependencies);
  }
}

export async function listUserApiKeys(
  input: Readonly<{ limit: number; after?: string }>,
  dependencies: UserApiKeyDependencies = defaultDependencies,
): Promise<number> {
  const request: UserApiKeyListRequest = {
    requestId: dependencies.requestId(),
    limit: input.limit,
    ...(input.after === undefined ? {} : { after: input.after }),
  };
  if (!isUserApiKeyListRequest(request)) {
    return writeFailure("list", failure("invalid_input", USER_API_KEY_EXIT.rejected), dependencies);
  }
  const query = new URLSearchParams({
    request_id: request.requestId,
    limit: String(request.limit),
  });
  if (request.after !== undefined) query.set("after", request.after);
  try {
    const client = await dependencies.getClient();
    const raw = await client.get(`${MINT_PATH}?${query.toString()}`, {
      signal: dependencies.signal(),
    });
    if (!isUserApiKeyListResponse(raw)) {
      return writeFailure(
        "list",
        failure("invalid_response", USER_API_KEY_EXIT.server),
        dependencies,
      );
    }
    const response = projectList(raw);
    const noun = response.apiKeys.length === 1 ? "key" : "keys";
    dependencies.writeStderr(`[prim] listed ${response.apiKeys.length} user API ${noun}.`);
    dependencies.writeStdout(JSON.stringify(response, null, 2));
    return USER_API_KEY_EXIT.ok;
  } catch (error) {
    return writeFailure("list", classifyError(error), dependencies);
  }
}

export async function revokeUserApiKey(
  apiKeyId: string,
  dependencies: UserApiKeyDependencies = defaultDependencies,
): Promise<number> {
  const request: UserApiKeyRevokeRequest = { requestId: dependencies.requestId() };
  if (!exactApiKeyId(apiKeyId) || !isUserApiKeyRevokeRequest(request)) {
    return writeFailure(
      "revoke",
      failure("invalid_input", USER_API_KEY_EXIT.rejected),
      dependencies,
    );
  }
  try {
    const client = await dependencies.getClient();
    const raw = await client.delete(`${MINT_PATH}/${encodeURIComponent(apiKeyId)}`, request, {
      signal: dependencies.signal(),
    });
    if (!isUserApiKeyRevokeResponse(raw) || raw.apiKeyId !== apiKeyId) {
      return writeFailure(
        "revoke",
        failure("invalid_response", USER_API_KEY_EXIT.server),
        dependencies,
      );
    }
    const response: UserApiKeyRevokeResponse = {
      apiKeyId: raw.apiKeyId,
      revoked: true,
    };
    dependencies.writeStderr(`[prim] API key ${response.apiKeyId} revoked.`);
    dependencies.writeStdout(JSON.stringify(response, null, 2));
    return USER_API_KEY_EXIT.ok;
  } catch (error) {
    return writeFailure("revoke", classifyError(error), dependencies);
  }
}
