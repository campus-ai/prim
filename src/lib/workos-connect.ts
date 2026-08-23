import { isWorkosConnectDeviceConfigurationSuccess } from "../contract/cli-http-v1.js";

const DISCOVERY_PATH = "/api/cli/auth/connect/config";
const DEVICE_AUTHORIZATION_PATH = "/oauth2/device_authorization";
const TOKEN_PATH = "/oauth2/token";
const DISCOVERY_MAX_BYTES = 16 * 1024;
export const WORKOS_CONNECT_RESPONSE_MAX_BYTES = 64 * 1024;
const MAX_DEVICE_LIFETIME_SECONDS = 60 * 60;
const MAX_TOKEN_LIFETIME_SECONDS = 24 * 60 * 60;
const MAX_INTERVAL_SECONDS = 60;
const POLL_REQUEST_TIMEOUT_MS = 30_000;
const SLOW_DOWN_SECONDS = 5;
const MAX_URL_LENGTH = 2048;
const MAX_DEVICE_CODE_LENGTH = 4096;
const MAX_USER_CODE_LENGTH = 128;
const MAX_CLIENT_ID_LENGTH = 256;
const CONNECT_CLIENT_ID_PATTERN = /^client_[A-Za-z0-9_-]+$/u;
const WORKOS_CONNECT_DEFAULT_SCOPES = ["openid", "profile", "email", "offline_access"] as const;

export type WorkosConnectConfiguration = Readonly<{
  issuer: string;
  clientId: string;
  scopes: readonly string[];
}>;

export type WorkosConnectCredentialContext = Readonly<{
  version: 1;
  family: "workos_connect";
  issuer: string;
  clientId: string;
}>;

export type WorkosConnectCredentialMetadata = WorkosConnectCredentialContext &
  Readonly<{ accessTokenHash: string; refreshTokenHash: string }>;

export type WorkosConnectDiscovery =
  | Readonly<{ state: "legacy_server" }>
  | Readonly<{ state: "available"; configuration: WorkosConnectConfiguration }>;

export type WorkosDeviceAuthorization = Readonly<{
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete?: string;
  expiresIn: number;
  interval: number;
}>;

export type WorkosConnectTokens = Readonly<{
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
}>;

export class WorkosConnectProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkosConnectProtocolError";
    this.code = code;
  }
}

function recordFrom(value: unknown, label: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new WorkosConnectProtocolError("invalid_response", `${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function exactString(value: unknown, field: string, maxLength: number): string {
  const containsControl =
    typeof value === "string" &&
    [...value].some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    });
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    value.trim() !== value ||
    containsControl
  ) {
    throw new WorkosConnectProtocolError("invalid_response", `${field} is invalid`);
  }
  return value;
}

function safeInteger(value: unknown, field: string, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new WorkosConnectProtocolError("invalid_response", `${field} is invalid`);
  }
  return value as number;
}

function canonicalIssuer(value: unknown): string {
  const issuer = exactString(value, "issuer", MAX_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(issuer);
  } catch {
    throw new WorkosConnectProtocolError("invalid_response", "issuer must be an HTTPS origin");
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.origin !== issuer
  ) {
    throw new WorkosConnectProtocolError("invalid_response", "issuer must be an HTTPS origin");
  }
  return issuer;
}

function sameIssuerUrl(value: unknown, field: string, issuer: string): string {
  const raw = exactString(value, field, MAX_URL_LENGTH);
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new WorkosConnectProtocolError("invalid_response", `${field} must be an HTTPS URL`);
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.username ||
    parsed.password ||
    parsed.origin !== issuer
  ) {
    throw new WorkosConnectProtocolError("invalid_response", `${field} is not trusted`);
  }
  return parsed.toString();
}

export function parseWorkosConnectConfiguration(value: unknown): WorkosConnectConfiguration {
  if (!isWorkosConnectDeviceConfigurationSuccess(value)) {
    throw new WorkosConnectProtocolError("invalid_response", "Connect discovery is invalid");
  }
  return {
    issuer: value.issuer,
    clientId: value.client_id,
    scopes: [...WORKOS_CONNECT_DEFAULT_SCOPES],
  };
}

export function parseWorkosConnectCredentialMetadata(
  value: unknown,
): WorkosConnectCredentialMetadata {
  const record = recordFrom(value, "credential metadata");
  if (record.version !== 1 || record.family !== "workos_connect") {
    throw new WorkosConnectProtocolError("invalid_metadata", "credential metadata is invalid");
  }
  const issuer = canonicalIssuer(record.issuer);
  const clientId = exactString(record.clientId, "clientId", MAX_CLIENT_ID_LENGTH);
  const accessTokenHash = exactString(record.accessTokenHash, "accessTokenHash", 64);
  const refreshTokenHash = exactString(record.refreshTokenHash, "refreshTokenHash", 64);
  if (!CONNECT_CLIENT_ID_PATTERN.test(clientId)) {
    throw new WorkosConnectProtocolError("invalid_metadata", "credential clientId is invalid");
  }
  if (!/^[a-f0-9]{64}$/u.test(accessTokenHash)) {
    throw new WorkosConnectProtocolError(
      "invalid_metadata",
      "credential accessTokenHash is invalid",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(refreshTokenHash)) {
    throw new WorkosConnectProtocolError(
      "invalid_metadata",
      "credential refreshTokenHash is invalid",
    );
  }
  return {
    version: 1,
    family: "workos_connect",
    issuer,
    clientId,
    accessTokenHash,
    refreshTokenHash,
  };
}

export async function readBoundedJson(response: Response, maxBytes: number): Promise<unknown> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    if (!/^\d+$/u.test(contentLength) || Number(contentLength) > maxBytes) {
      throw new WorkosConnectProtocolError("invalid_response", "response body is too large");
    }
  }
  if (!response.body) {
    throw new WorkosConnectProtocolError("invalid_response", "response body is missing");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const result = await reader.read();
      if (result.done) break;
      total += result.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new WorkosConnectProtocolError("invalid_response", "response body is too large");
      }
      chunks.push(result.value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return JSON.parse(text) as unknown;
  } catch {
    throw new WorkosConnectProtocolError("invalid_response", "response body is not valid JSON");
  }
}

export async function discoverWorkosConnect(
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<WorkosConnectDiscovery> {
  const response = await fetchImpl(`${siteUrl}${DISCOVERY_PATH}`, { signal });
  if (response.status === 404) return { state: "legacy_server" };
  if (!response.ok) {
    throw new WorkosConnectProtocolError(
      "discovery_unavailable",
      `Connect discovery returned HTTP ${response.status}`,
    );
  }
  return {
    state: "available",
    configuration: parseWorkosConnectConfiguration(
      await readBoundedJson(response, DISCOVERY_MAX_BYTES),
    ),
  };
}

export function workosConnectTokenEndpoint(issuer: string): string {
  return `${issuer}${TOKEN_PATH}`;
}

export async function requestWorkosDeviceAuthorization(
  configuration: WorkosConnectConfiguration,
  fetchImpl: typeof fetch = fetch,
  signal: AbortSignal = AbortSignal.timeout(10_000),
): Promise<WorkosDeviceAuthorization> {
  const body = new URLSearchParams({
    client_id: configuration.clientId,
    scope: configuration.scopes.join(" "),
  });
  const response = await fetchImpl(`${configuration.issuer}${DEVICE_AUTHORIZATION_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
    signal,
  });
  const value = await readBoundedJson(response, WORKOS_CONNECT_RESPONSE_MAX_BYTES);
  if (!response.ok) {
    const error = recordFrom(value, "device authorization error").error;
    throw new WorkosConnectProtocolError(
      typeof error === "string" ? error : "device_authorization_failed",
      `Device authorization returned HTTP ${response.status}`,
    );
  }
  const record = recordFrom(value, "device authorization");
  const verificationUri = sameIssuerUrl(
    record.verification_uri,
    "verification_uri",
    configuration.issuer,
  );
  return {
    deviceCode: exactString(record.device_code, "device_code", MAX_DEVICE_CODE_LENGTH),
    userCode: exactString(record.user_code, "user_code", MAX_USER_CODE_LENGTH),
    verificationUri,
    verificationUriComplete:
      record.verification_uri_complete === undefined
        ? undefined
        : sameIssuerUrl(
            record.verification_uri_complete,
            "verification_uri_complete",
            configuration.issuer,
          ),
    expiresIn: safeInteger(record.expires_in, "expires_in", 1, MAX_DEVICE_LIFETIME_SECONDS),
    interval: safeInteger(record.interval ?? 5, "interval", 1, MAX_INTERVAL_SECONDS),
  };
}

export function parseWorkosConnectTokens(
  value: unknown,
  options: Readonly<{ fallbackRefreshToken?: string }> = {},
): WorkosConnectTokens {
  const record = recordFrom(value, "token response");
  const accessToken = exactString(
    record.access_token,
    "access_token",
    WORKOS_CONNECT_RESPONSE_MAX_BYTES,
  );
  const refreshToken =
    record.refresh_token === undefined && options.fallbackRefreshToken !== undefined
      ? options.fallbackRefreshToken
      : exactString(record.refresh_token, "refresh_token", WORKOS_CONNECT_RESPONSE_MAX_BYTES);
  return {
    accessToken,
    refreshToken,
    expiresIn:
      record.expires_in === undefined
        ? undefined
        : safeInteger(record.expires_in, "expires_in", 1, MAX_TOKEN_LIFETIME_SECONDS),
  };
}

function providerError(value: unknown): string {
  const error = recordFrom(value, "token error").error;
  return exactString(error, "error", MAX_USER_CODE_LENGTH);
}

async function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function pollWorkosDeviceAuthorization(
  configuration: WorkosConnectConfiguration,
  authorization: WorkosDeviceAuthorization,
  options: Readonly<{
    fetch?: typeof fetch;
    now?: () => number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
    signal?: AbortSignal;
  }> = {},
): Promise<WorkosConnectTokens> {
  const fetchImpl = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal ?? AbortSignal.timeout(authorization.expiresIn * 1000);
  const deadline = now() + authorization.expiresIn * 1000;
  let intervalSeconds = authorization.interval;

  while (now() < deadline) {
    await sleep(Math.min(intervalSeconds * 1000, Math.max(0, deadline - now())), signal);
    if (now() >= deadline) break;
    let response: Response;
    try {
      response = await fetchImpl(workosConnectTokenEndpoint(configuration.issuer), {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: authorization.deviceCode,
          client_id: configuration.clientId,
        }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(POLL_REQUEST_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) {
        throw new WorkosConnectProtocolError("expired_token", "Device authorization expired");
      }
      continue;
    }
    const value = await readBoundedJson(response, WORKOS_CONNECT_RESPONSE_MAX_BYTES);
    if (response.ok) return parseWorkosConnectTokens(value);

    const error = providerError(value);
    if (error === "authorization_pending") continue;
    if (error === "slow_down") {
      intervalSeconds = Math.min(MAX_INTERVAL_SECONDS, intervalSeconds + SLOW_DOWN_SECONDS);
      continue;
    }
    if (error === "access_denied" || error === "expired_token") {
      throw new WorkosConnectProtocolError(error, `Device authorization failed: ${error}`);
    }
    throw new WorkosConnectProtocolError(error, "Token endpoint rejected device authorization");
  }
  throw new WorkosConnectProtocolError("expired_token", "Device authorization expired");
}
