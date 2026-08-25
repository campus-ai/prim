/** WorkOS user API-key management for the authenticated CLI user. */

import { randomBytes } from "node:crypto";
import {
  type CliManagementClient,
  CliManagementResponseError,
  HttpError,
  getPinnedManagementClient,
} from "../client.js";
import { isCliErrorResponse } from "../contract/cli-http-v1.js";
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

type UserApiKeyMetadata = Readonly<{
  id: string;
  name: string;
  obfuscatedValue: string;
  permissions: readonly string[];
  lastUsedAt: number | null;
  expiresAt: number | null;
  createdAt: number;
  updatedAt: number;
}>;

type UserApiKeyMintResponse = Readonly<{ apiKey: UserApiKeyMetadata; secret: string }>;
type UserApiKeyListResponse = Readonly<{
  apiKeys: readonly UserApiKeyMetadata[];
  nextCursor: string | null;
}>;
type UserApiKeyRevokeResponse = Readonly<{ apiKeyId: string; revoked: true }>;

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
const API_KEY_NAME = /^[\x21-\x7e](?:[\x20-\x7e]{0,126}[\x21-\x7e])?$/u;
const API_KEY_PERMISSION = /^[\x21-\x7e]+$/u;
const API_KEY_SECRET = /^sk_[\x21-\x7e]+(?: [\x21-\x7e]+)*$/u;
const API_KEY_OBFUSCATED_VALUE = /^[\x20-\x7e]+$/u;
const MINT_PATH = "/api/cli/auth/api-keys";
const REQUEST_ID = /^[a-f0-9]{64}$/u;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function hasExactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function isSafeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isBoundedString(
  value: unknown,
  minimum: number,
  maximum: number,
  pattern?: RegExp,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= minimum &&
    value.length <= maximum &&
    (pattern === undefined || pattern.test(value))
  );
}

function isApiKeyId(value: unknown): value is string {
  return isBoundedString(value, 9, 256, API_KEY_ID);
}

function isApiKeyName(value: unknown): value is string {
  return isBoundedString(value, 1, 128, API_KEY_NAME);
}

function isMetadata(value: unknown): UserApiKeyMetadata | undefined {
  const parsed = record(value);
  if (
    parsed === undefined ||
    !hasExactKeys(parsed, [
      "id",
      "name",
      "obfuscatedValue",
      "permissions",
      "lastUsedAt",
      "expiresAt",
      "createdAt",
      "updatedAt",
    ])
  ) {
    return undefined;
  }
  const { id, name, obfuscatedValue, permissions, lastUsedAt, expiresAt, createdAt, updatedAt } =
    parsed;
  if (
    !isApiKeyId(id) ||
    !isApiKeyName(name) ||
    !isBoundedString(obfuscatedValue, 1, 256, API_KEY_OBFUSCATED_VALUE) ||
    !Array.isArray(permissions) ||
    permissions.length > 100 ||
    !permissions.every((permission) => isBoundedString(permission, 1, 128, API_KEY_PERMISSION)) ||
    (lastUsedAt !== null && !isSafeTimestamp(lastUsedAt)) ||
    (expiresAt !== null && !isSafeTimestamp(expiresAt)) ||
    !isSafeTimestamp(createdAt) ||
    !isSafeTimestamp(updatedAt)
  ) {
    return undefined;
  }
  return {
    id,
    name,
    obfuscatedValue,
    permissions: [...permissions],
    lastUsedAt,
    expiresAt,
    createdAt,
    updatedAt,
  };
}

function parseMintResponse(value: unknown): UserApiKeyMintResponse | undefined {
  const parsed = record(value);
  if (parsed === undefined || !hasExactKeys(parsed, ["apiKey", "secret"])) return undefined;
  const apiKey = isMetadata(parsed.apiKey);
  return apiKey && isBoundedString(parsed.secret, 4, 4_096, API_KEY_SECRET)
    ? { apiKey, secret: parsed.secret }
    : undefined;
}

function parseListResponse(value: unknown): UserApiKeyListResponse | undefined {
  const parsed = record(value);
  if (
    parsed === undefined ||
    !hasExactKeys(parsed, ["apiKeys", "nextCursor"]) ||
    !Array.isArray(parsed.apiKeys) ||
    parsed.apiKeys.length > 100 ||
    (parsed.nextCursor !== null && !isApiKeyId(parsed.nextCursor))
  ) {
    return undefined;
  }
  const apiKeys: UserApiKeyMetadata[] = [];
  for (const value of parsed.apiKeys) {
    const apiKey = isMetadata(value);
    if (!apiKey) return undefined;
    apiKeys.push(apiKey);
  }
  return { apiKeys, nextCursor: parsed.nextCursor };
}

function parseRevokeResponse(value: unknown): UserApiKeyRevokeResponse | undefined {
  const parsed = record(value);
  return parsed !== undefined &&
    hasExactKeys(parsed, ["apiKeyId", "revoked"]) &&
    isApiKeyId(parsed.apiKeyId) &&
    parsed.revoked === true
    ? { apiKeyId: parsed.apiKeyId, revoked: true }
    : undefined;
}

function failure(
  code: UserApiKeyFailureCode,
  exitCode: number,
  status?: number,
): UserApiKeyFailure {
  return { code, exitCode, ...(status === undefined ? {} : { status }) };
}

function classifyHttpError(
  error: HttpError,
  operation: UserApiKeyOperation,
  dispatched: boolean,
): UserApiKeyFailure {
  if (error.status === 401) {
    return failure("authentication_required", USER_API_KEY_EXIT.auth, error.status);
  }
  if (operation === "mint" && dispatched && error.status >= 500) {
    return failure("operation_uncertain", USER_API_KEY_EXIT.server, error.status);
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

function classifyError(
  error: unknown,
  operation: UserApiKeyOperation,
  dispatched: boolean,
): UserApiKeyFailure {
  if (error instanceof HttpError) return classifyHttpError(error, operation, dispatched);
  if (error instanceof CliManagementResponseError) {
    return operation === "mint" && dispatched
      ? failure("operation_uncertain", USER_API_KEY_EXIT.server)
      : failure("invalid_response", USER_API_KEY_EXIT.server);
  }
  return operation === "mint" && dispatched
    ? failure("operation_uncertain", USER_API_KEY_EXIT.server)
    : failure("transport_error", USER_API_KEY_EXIT.server);
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
  const requestId = dependencies.requestId();
  if (
    !REQUEST_ID.test(requestId) ||
    !isApiKeyName(input.name) ||
    (input.expiresAt !== undefined && !isSafeTimestamp(input.expiresAt))
  ) {
    return writeFailure("mint", failure("invalid_input", USER_API_KEY_EXIT.rejected), dependencies);
  }
  const request = {
    requestId,
    name: input.name,
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  };
  let dispatched = false;
  try {
    const client = await dependencies.getClient();
    const signal = dependencies.signal();
    dispatched = true;
    const response = parseMintResponse(await client.post(MINT_PATH, request, { signal }));
    if (
      !response ||
      response.apiKey.name !== request.name ||
      (request.expiresAt !== undefined && response.apiKey.expiresAt !== request.expiresAt)
    ) {
      return writeFailure(
        "mint",
        failure("operation_uncertain", USER_API_KEY_EXIT.server),
        dependencies,
      );
    }
    dependencies.writeStderr(
      `[prim] API key ${response.apiKey.id} minted. Save the secret from stdout now; it will not be shown again.`,
    );
    dependencies.writeStdout(JSON.stringify(response, null, 2));
    return USER_API_KEY_EXIT.ok;
  } catch (error) {
    return writeFailure("mint", classifyError(error, "mint", dispatched), dependencies);
  }
}

export async function listUserApiKeys(
  input: Readonly<{ limit: number; after?: string }>,
  dependencies: UserApiKeyDependencies = defaultDependencies,
): Promise<number> {
  const requestId = dependencies.requestId();
  if (
    !REQUEST_ID.test(requestId) ||
    !Number.isInteger(input.limit) ||
    input.limit < 1 ||
    input.limit > 100 ||
    (input.after !== undefined && !isApiKeyId(input.after))
  ) {
    return writeFailure("list", failure("invalid_input", USER_API_KEY_EXIT.rejected), dependencies);
  }
  const query = new URLSearchParams({ request_id: requestId, limit: String(input.limit) });
  if (input.after !== undefined) query.set("after", input.after);
  try {
    const client = await dependencies.getClient();
    const response = parseListResponse(
      await client.get(`${MINT_PATH}?${query.toString()}`, { signal: dependencies.signal() }),
    );
    if (!response) {
      return writeFailure(
        "list",
        failure("invalid_response", USER_API_KEY_EXIT.server),
        dependencies,
      );
    }
    const noun = response.apiKeys.length === 1 ? "key" : "keys";
    dependencies.writeStderr(`[prim] listed ${response.apiKeys.length} user API ${noun}.`);
    dependencies.writeStdout(JSON.stringify(response, null, 2));
    return USER_API_KEY_EXIT.ok;
  } catch (error) {
    return writeFailure("list", classifyError(error, "list", false), dependencies);
  }
}

export async function revokeUserApiKey(
  apiKeyId: string,
  dependencies: UserApiKeyDependencies = defaultDependencies,
): Promise<number> {
  const requestId = dependencies.requestId();
  if (!isApiKeyId(apiKeyId) || !REQUEST_ID.test(requestId)) {
    return writeFailure(
      "revoke",
      failure("invalid_input", USER_API_KEY_EXIT.rejected),
      dependencies,
    );
  }
  try {
    const client = await dependencies.getClient();
    const response = parseRevokeResponse(
      await client.delete(
        `${MINT_PATH}/${encodeURIComponent(apiKeyId)}`,
        { requestId },
        {
          signal: dependencies.signal(),
        },
      ),
    );
    if (!response || response.apiKeyId !== apiKeyId) {
      return writeFailure(
        "revoke",
        failure("invalid_response", USER_API_KEY_EXIT.server),
        dependencies,
      );
    }
    dependencies.writeStderr(`[prim] API key ${response.apiKeyId} revoked.`);
    dependencies.writeStdout(JSON.stringify(response, null, 2));
    return USER_API_KEY_EXIT.ok;
  } catch (error) {
    return writeFailure("revoke", classifyError(error, "revoke", false), dependencies);
  }
}
