/** REST client and shared credential store for the prim CLI. */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import { atomicWriteFile } from "./lib/atomic-file.js";
import {
  type AuthCredential,
  type AuthCredentialSource,
  CREDENTIAL_FAMILY_PATH,
  CREDENTIAL_LOCK_PATH,
  CREDENTIAL_METADATA_PATH,
  type LegacyBrokerCredentialMetadata,
  REFRESH_TOKEN_PATH,
  type StoredCredentialMetadataResolution,
  TERMINAL_REFRESH_PATH,
  TOKEN_EXPIRES_PATH,
  TOKEN_FILE_PATH,
  jwtExpiresAt,
  readStoredCredentialMetadata,
  resolveAuthCredential,
} from "./lib/credentials.js";
import { type FileLockOptions, withFileLock } from "./lib/file-lock.js";
import {
  WORKOS_CONNECT_RESPONSE_MAX_BYTES,
  type WorkosConnectCredentialContext,
  type WorkosConnectCredentialMetadata,
  parseWorkosConnectTokens,
  readBoundedJson,
  workosConnectTokenEndpoint,
} from "./lib/workos-connect.js";

const CONFIG_DIR_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o600;
const REFRESH_THRESHOLD_MS = 60_000;
const DEFAULT_API_URL = "https://api.getprimitive.ai";
const AUTH_EXPIRED_MESSAGE = "Authentication expired. Run `prim auth login` to re-authenticate.";

export {
  CREDENTIAL_FAMILY_PATH,
  CREDENTIAL_METADATA_PATH,
  CREDENTIAL_LOCK_PATH,
  REFRESH_TOKEN_PATH,
  resolveAuthCredential,
  TERMINAL_REFRESH_PATH,
  TOKEN_EXPIRES_PATH,
  TOKEN_FILE_PATH,
};
export type {
  AuthCredential,
  AuthCredentialSource,
  LegacyBrokerCredentialMetadata,
  StoredCredentialMetadataResolution,
  WorkosConnectCredentialContext,
  WorkosConnectCredentialMetadata,
};

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
  metadata?: WorkosConnectCredentialContext;
}

export type CredentialLockOptions = FileLockOptions;

function readTrimmed(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Backwards-compatible token-only resolver. */
export function getAuthToken(): string | undefined {
  return resolveAuthCredential()?.token;
}

export function getSiteUrl(): string {
  return getSiteUrlForEnvironment(process.env.PRIM_API_URL);
}

/** Resolve a deployment from explicit process state, never repository files. */
export function getSiteUrlForEnvironment(primApiUrl?: string): string {
  return primApiUrl?.trim() || DEFAULT_API_URL;
}

function expiresAtFor(token: string, expiresIn?: number): number | undefined {
  return expiresIn === undefined ? jwtExpiresAt(token) : Date.now() + expiresIn * 1000;
}

function ensureConfigDirectory(): void {
  const directory = dirname(TOKEN_FILE_PATH);
  mkdirSync(directory, { recursive: true, mode: CONFIG_DIR_MODE });
  chmodSync(directory, CONFIG_DIR_MODE);
}

function atomicWrite(path: string, content: string): void {
  ensureConfigDirectory();
  atomicWriteFile(path, content, { mode: CREDENTIAL_FILE_MODE });
}

function removeCredentialFile(path: string): boolean {
  if (!existsSync(path)) return false;
  rmSync(path, { force: true });
  return true;
}

export function getTokenExpiresAt(): number | undefined {
  const stored = readTrimmed(TOKEN_EXPIRES_PATH);
  if (stored === undefined) return undefined;
  const value = Number(stored);
  return Number.isNaN(value) ? undefined : value;
}

function isTokenExpiringSoon(credential: AuthCredential): boolean {
  if (credential.source !== "token_file") return false;
  const expiresAt = getTokenExpiresAt();
  return expiresAt !== undefined && Date.now() >= expiresAt - REFRESH_THRESHOLD_MS;
}

function refreshFingerprint(refreshToken: string): string {
  return createHash("sha256").update(refreshToken).digest("hex");
}

function credentialFamilyMetadata(
  accessToken: string,
  refreshToken: string,
  metadata: WorkosConnectCredentialContext | undefined,
): WorkosConnectCredentialMetadata | LegacyBrokerCredentialMetadata {
  const hashes = {
    accessTokenHash: refreshFingerprint(accessToken),
    refreshTokenHash: refreshFingerprint(refreshToken),
  };
  return metadata === undefined
    ? { version: 1, family: "legacy_broker", ...hashes }
    : { ...metadata, ...hashes };
}

function terminalFingerprint(): string | undefined {
  return readTrimmed(TERMINAL_REFRESH_PATH);
}

function writeTerminalFingerprint(refreshToken: string): void {
  atomicWrite(TERMINAL_REFRESH_PATH, `${refreshFingerprint(refreshToken)}\n`);
}

function clearTerminalFingerprint(): void {
  removeCredentialFile(TERMINAL_REFRESH_PATH);
}

/** True only while the persisted terminal marker matches the current refresh generation. */
export function isSessionEnded(): boolean {
  if (resolveAuthCredential()?.source !== "token_file") return false;
  const refreshToken = readTrimmed(REFRESH_TOKEN_PATH);
  const ended = terminalFingerprint();
  return Boolean(refreshToken && ended && refreshFingerprint(refreshToken) === ended);
}

export function withCredentialLock<T>(
  operation: () => Promise<T> | T,
  options: CredentialLockOptions = {},
): Promise<T> {
  return withFileLock(CREDENTIAL_LOCK_PATH, operation, options);
}

function commitCredentialsUnlocked(credentials: StoredCredentials): void {
  const accessToken = credentials.accessToken.trim();
  const refreshToken = credentials.refreshToken.trim();
  if (!accessToken || !refreshToken) {
    throw new Error("OAuth credentials require both access and refresh tokens");
  }

  // Access is the commit marker. A Connect family is written before either
  // token so a missing old metadata file cannot reclassify it as legacy. A
  // legacy family follows its replacement refresh, so a crash cannot mark an
  // old Connect refresh as broker-owned. The old Connect metadata remains for
  // rolling-client compatibility until the legacy generation is ready.
  const familyMetadata = credentialFamilyMetadata(accessToken, refreshToken, credentials.metadata);
  if (credentials.metadata !== undefined) {
    atomicWrite(CREDENTIAL_FAMILY_PATH, `${JSON.stringify(familyMetadata)}\n`);
    atomicWrite(CREDENTIAL_METADATA_PATH, `${JSON.stringify(familyMetadata)}\n`);
    atomicWrite(REFRESH_TOKEN_PATH, `${refreshToken}\n`);
  } else {
    atomicWrite(REFRESH_TOKEN_PATH, `${refreshToken}\n`);
    atomicWrite(CREDENTIAL_FAMILY_PATH, `${JSON.stringify(familyMetadata)}\n`);
    removeCredentialFile(CREDENTIAL_METADATA_PATH);
  }
  const expiresAt = expiresAtFor(accessToken, credentials.expiresIn);
  if (expiresAt === undefined) removeCredentialFile(TOKEN_EXPIRES_PATH);
  else atomicWrite(TOKEN_EXPIRES_PATH, `${expiresAt}\n`);
  atomicWrite(TOKEN_FILE_PATH, `${accessToken}\n`);
  clearTerminalFingerprint();
  _cachedCredential = { token: accessToken, source: "token_file" };
}

/** Atomically commit a browser-OAuth generation under the shared credential lock. */
export async function commitCredentials(
  credentials: StoredCredentials,
  options: CredentialLockOptions = {},
): Promise<void> {
  await withCredentialLock(() => commitCredentialsUnlocked(credentials), options);
}

/** Store a fixed bearer and remove every browser-OAuth artifact it supersedes. */
export async function setStoredToken(
  token: string,
  options: CredentialLockOptions = {},
): Promise<void> {
  const value = token.trim();
  if (!value) throw new Error("Token cannot be empty");
  await withCredentialLock(() => {
    removeCredentialFile(REFRESH_TOKEN_PATH);
    removeCredentialFile(TOKEN_EXPIRES_PATH);
    removeCredentialFile(CREDENTIAL_FAMILY_PATH);
    removeCredentialFile(CREDENTIAL_METADATA_PATH);
    clearTerminalFingerprint();
    atomicWrite(TOKEN_FILE_PATH, `${value}\n`);
    _cachedCredential = { token: value, source: "token_file" };
  }, options);
}

export interface ClearStoredCredentialsOptions extends CredentialLockOptions {
  beforeClear?: (
    refreshToken: string | undefined,
    metadata: StoredCredentialMetadataResolution,
  ) => Promise<void> | void;
}

/** Revoke/inspect and delete one coherent credential generation under one lock. */
export async function clearStoredCredentials(
  options: ClearStoredCredentialsOptions = {},
): Promise<boolean> {
  const { beforeClear, ...lockOptions } = options;
  return withCredentialLock(async () => {
    const accessToken = readTrimmed(TOKEN_FILE_PATH);
    const refreshToken = readTrimmed(REFRESH_TOKEN_PATH);
    const metadata = readStoredCredentialMetadata();
    const protectedMetadata =
      metadata.state === "legacy_broker" &&
      metadata.metadata !== undefined &&
      (!refreshToken ||
        metadata.metadata.accessTokenHash !== refreshFingerprint(accessToken ?? "") ||
        metadata.metadata.refreshTokenHash !== refreshFingerprint(refreshToken))
        ? { state: "invalid" as const }
        : metadata;
    let callbackError: unknown;
    try {
      await beforeClear?.(refreshToken, protectedMetadata);
    } catch (error) {
      callbackError = error;
    }

    let removed = false;
    for (const path of [
      TOKEN_FILE_PATH,
      REFRESH_TOKEN_PATH,
      TOKEN_EXPIRES_PATH,
      CREDENTIAL_FAMILY_PATH,
      CREDENTIAL_METADATA_PATH,
      TERMINAL_REFRESH_PATH,
    ]) {
      removed = removeCredentialFile(path) || removed;
    }
    _cachedCredential = undefined;
    if (callbackError) throw callbackError;
    return removed;
  }, lockOptions);
}

export type RequestOptions = {
  signal?: AbortSignal;
  /** Suppress broker diagnostics on machine-protocol hook paths. */
  quietRefresh?: boolean;
};

export interface RefreshOptions {
  signal?: AbortSignal;
  quiet?: boolean;
  /** Documents that the caller intentionally verifies by rotating now. */
  force?: boolean;
  /** Freeze a deployment across a multi-request credential-bound operation. */
  siteUrl?: string;
}

function isTerminalRefreshResponse(response: Response, detail: string): boolean {
  if (detail.includes("invalid_grant") || detail.includes("Session has already ended")) return true;
  try {
    const error = (JSON.parse(detail) as { error?: string }).error;
    return (
      error === "invalid_grant" ||
      (response.status === 401 && error === "Invalid or expired refresh token")
    );
  } catch {
    return response.status === 401 && detail.includes("Invalid or expired refresh token");
  }
}

function refreshDiagnostic(response: Response, detail: string, quiet: boolean | undefined): void {
  if (quiet) return;
  process.stderr.write(
    `[prim] token refresh rejected: ${response.status} ${response.statusText}${
      detail ? ` — ${detail}` : ""
    }\n`,
  );
}

function metadataMatchesCredentialGeneration(
  expected: StoredCredentialMetadataResolution,
  accessToken: string,
  refreshToken: string,
): boolean {
  const current = readStoredCredentialMetadata();
  if (expected.state === "legacy_broker") {
    if (current.state !== "legacy_broker") return false;
    if (!expected.metadata) return current.metadata === undefined;
    return (
      current.metadata !== undefined &&
      current.metadata.accessTokenHash === refreshFingerprint(accessToken) &&
      current.metadata.accessTokenHash === expected.metadata.accessTokenHash &&
      current.metadata.refreshTokenHash === refreshFingerprint(refreshToken) &&
      current.metadata.refreshTokenHash === expected.metadata.refreshTokenHash
    );
  }
  if (expected.state !== "workos_connect" || current.state !== "workos_connect") return false;
  return (
    current.metadata.issuer === expected.metadata.issuer &&
    current.metadata.clientId === expected.metadata.clientId &&
    current.metadata.accessTokenHash === refreshFingerprint(accessToken) &&
    current.metadata.accessTokenHash === expected.metadata.accessTokenHash &&
    current.metadata.refreshTokenHash === refreshFingerprint(refreshToken) &&
    current.metadata.refreshTokenHash === expected.metadata.refreshTokenHash
  );
}

async function performTokenRefresh(options: RefreshOptions = {}): Promise<string | undefined> {
  const selected = resolveAuthCredential();
  if (selected?.source !== "token_file") return undefined;
  const startingGeneration = readTrimmed(REFRESH_TOKEN_PATH);
  if (!startingGeneration || isSessionEnded()) return undefined;
  const startingAccessToken = selected.token;

  return withCredentialLock(
    async () => {
      const currentCredential = resolveAuthCredential();
      if (currentCredential?.source !== "token_file") return undefined;
      const currentGeneration = readTrimmed(REFRESH_TOKEN_PATH);
      if (!currentGeneration) return undefined;

      // A winner rotated while this process waited. Adopt its committed access
      // token instead of consuming the replacement refresh token again.
      if (currentGeneration !== startingGeneration) {
        return currentCredential.token;
      }
      // Non-rotation winner: a concurrent refresh committed a fresh access
      // token against the SAME refresh generation (WorkOS declined to rotate,
      // so the generation string never changed). Adopt it rather than firing a
      // redundant broker round-trip that only re-consumes the live token.
      if (currentCredential.token !== startingAccessToken) {
        return currentCredential.token;
      }
      if (isSessionEnded()) return undefined;

      const metadata = readStoredCredentialMetadata();
      if (
        metadata.state === "invalid" ||
        (metadata.state === "workos_connect" &&
          (metadata.metadata.accessTokenHash !== refreshFingerprint(currentCredential.token) ||
            metadata.metadata.refreshTokenHash !== refreshFingerprint(currentGeneration))) ||
        (metadata.state === "legacy_broker" &&
          metadata.metadata !== undefined &&
          (metadata.metadata.accessTokenHash !== refreshFingerprint(currentCredential.token) ||
            metadata.metadata.refreshTokenHash !== refreshFingerprint(currentGeneration)))
      ) {
        return undefined;
      }

      const connectContext =
        metadata.state === "workos_connect"
          ? {
              version: 1 as const,
              family: "workos_connect" as const,
              issuer: metadata.metadata.issuer,
              clientId: metadata.metadata.clientId,
            }
          : undefined;
      const response = await fetch(
        connectContext
          ? workosConnectTokenEndpoint(connectContext.issuer)
          : `${options.siteUrl ?? getSiteUrl()}/mcp/broker/refresh`,
        connectContext
          ? {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "refresh_token",
                refresh_token: currentGeneration,
                client_id: connectContext.clientId,
              }),
              signal: options.signal,
            }
          : {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refresh_token: currentGeneration }),
              signal: options.signal,
            },
      );

      let directResponse: unknown;
      if (connectContext) {
        try {
          directResponse = await readBoundedJson(response, WORKOS_CONNECT_RESPONSE_MAX_BYTES);
        } catch {
          if (
            response.ok &&
            readTrimmed(REFRESH_TOKEN_PATH) === currentGeneration &&
            metadataMatchesCredentialGeneration(
              metadata,
              currentCredential.token,
              currentGeneration,
            )
          ) {
            writeTerminalFingerprint(currentGeneration);
          }
          return undefined;
        }
      }

      if (!response.ok) {
        const detail = connectContext
          ? JSON.stringify(directResponse).slice(0, 200)
          : (await response.text().catch(() => "")).slice(0, 200);
        // An older uncoordinated client could have replaced the files while the
        // request was in flight. Never poison that newer generation.
        if (
          isTerminalRefreshResponse(response, detail) &&
          readTrimmed(REFRESH_TOKEN_PATH) === currentGeneration &&
          metadataMatchesCredentialGeneration(metadata, currentCredential.token, currentGeneration)
        ) {
          writeTerminalFingerprint(currentGeneration);
        }
        refreshDiagnostic(response, detail, options.quiet);
        const winner = resolveAuthCredential();
        return readTrimmed(REFRESH_TOKEN_PATH) !== currentGeneration &&
          winner?.source === "token_file"
          ? winner.token
          : undefined;
      }

      let accessToken: string;
      let replacementRefreshToken: string;
      let expiresIn: number | undefined;
      if (connectContext) {
        try {
          const tokens = parseWorkosConnectTokens(directResponse, {
            fallbackRefreshToken: currentGeneration,
          });
          accessToken = tokens.accessToken;
          replacementRefreshToken = tokens.refreshToken;
          expiresIn = tokens.expiresIn;
        } catch {
          if (
            readTrimmed(REFRESH_TOKEN_PATH) === currentGeneration &&
            metadataMatchesCredentialGeneration(
              metadata,
              currentCredential.token,
              currentGeneration,
            )
          ) {
            writeTerminalFingerprint(currentGeneration);
          }
          return undefined;
        }
      } else {
        let data: unknown;
        try {
          data = await response.json();
        } catch {
          if (readTrimmed(REFRESH_TOKEN_PATH) === currentGeneration) {
            writeTerminalFingerprint(currentGeneration);
          }
          return undefined;
        }
        const record =
          typeof data === "object" && data !== null && !Array.isArray(data)
            ? (data as Record<string, unknown>)
            : undefined;
        accessToken = typeof record?.access_token === "string" ? record.access_token.trim() : "";
        replacementRefreshToken =
          typeof record?.refresh_token === "string" ? record.refresh_token.trim() : "";
        expiresIn =
          typeof record?.expires_in === "number" && Number.isFinite(record.expires_in)
            ? record.expires_in
            : undefined;
        if (!(accessToken && replacementRefreshToken)) {
          if (readTrimmed(REFRESH_TOKEN_PATH) === currentGeneration) {
            writeTerminalFingerprint(currentGeneration);
          }
          return undefined;
        }
      }

      const latestCredential = resolveAuthCredential();
      if (
        readTrimmed(REFRESH_TOKEN_PATH) !== currentGeneration ||
        latestCredential?.source !== "token_file" ||
        latestCredential.token !== currentCredential.token ||
        !metadataMatchesCredentialGeneration(metadata, currentCredential.token, currentGeneration)
      ) {
        return latestCredential?.source === "token_file" ? latestCredential.token : undefined;
      }

      commitCredentialsUnlocked({
        accessToken,
        refreshToken: replacementRefreshToken,
        expiresIn,
        metadata: connectContext,
      });
      return accessToken;
    },
    { signal: options.signal },
  );
}

let _refreshInFlight: Promise<string | undefined> | undefined;

/** One refresh-token rotation per process and on-disk credential generation. */
export function refreshToken(options: RefreshOptions = {}): Promise<string | undefined> {
  if (_refreshInFlight) return _refreshInFlight;
  const attempt = performTokenRefresh(options)
    .then((token) => {
      if (token) _cachedCredential = { token, source: "token_file" };
      return token;
    })
    .finally(() => {
      if (_refreshInFlight === attempt) _refreshInFlight = undefined;
    });
  _refreshInFlight = attempt;
  return attempt;
}

export class HttpError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
  }
}

/** A successful management response could not be decoded within its strict bound. */
export class CliManagementResponseError extends Error {
  constructor() {
    super("Invalid API-key management response");
    this.name = "CliManagementResponseError";
  }
}

export interface CliClient {
  get(path: string, options?: RequestOptions): Promise<unknown>;
  post(path: string, body?: unknown, options?: RequestOptions): Promise<unknown>;
}

/** Pinned transport used by user API-key management, including DELETE. */
export interface CliManagementClient extends CliClient {
  delete(path: string, body?: unknown, options?: RequestOptions): Promise<unknown>;
}

const CLI_MANAGEMENT_RESPONSE_MAX_BYTES = 2 * 1024 * 1024;

async function managementResponseValue(response: Response): Promise<unknown> {
  if (response.status === 401) {
    throw new HttpError(401, AUTH_EXPIRED_MESSAGE);
  }
  let value: unknown;
  try {
    value = await readBoundedJson(response, CLI_MANAGEMENT_RESPONSE_MAX_BYTES);
  } catch {
    if (response.ok) throw new CliManagementResponseError();
    throw new HttpError(response.status, `HTTP ${response.status}`, null);
  }
  if (!response.ok) {
    const errorRecord =
      typeof value === "object" && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : undefined;
    const message =
      typeof errorRecord?.error === "string" ? errorRecord.error : `HTTP ${response.status}`;
    throw new HttpError(response.status, message, value);
  }
  return value;
}

let _cachedCredential: AuthCredential | undefined;

function selectedCredential(): AuthCredential | undefined {
  const resolved = resolveAuthCredential();
  if (
    !_cachedCredential ||
    resolved?.token !== _cachedCredential.token ||
    resolved?.source !== _cachedCredential.source
  ) {
    _cachedCredential = resolved;
  }
  return _cachedCredential;
}

function fetchWithToken(
  method: string,
  path: string,
  body: unknown,
  options: RequestOptions | undefined,
  token: string,
  siteUrl: string = getSiteUrl(),
): Promise<Response> {
  return fetch(`${siteUrl}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: options?.signal,
  });
}

async function responseValue(response: Response): Promise<unknown> {
  if (!response.ok) {
    if (response.status === 401) {
      throw new HttpError(401, AUTH_EXPIRED_MESSAGE);
    }
    const errorBody: unknown = await response.json().catch(() => null);
    const errorRecord =
      typeof errorBody === "object" && errorBody !== null && !Array.isArray(errorBody)
        ? (errorBody as Record<string, unknown>)
        : undefined;
    const message =
      typeof errorRecord?.error === "string" ? errorRecord.error : `HTTP ${response.status}`;
    throw new HttpError(response.status, message, errorBody);
  }
  return response.json();
}

async function request(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<unknown> {
  let credential = selectedCredential();
  let refreshAttempted = false;

  if (credential && isTokenExpiringSoon(credential)) {
    refreshAttempted = true;
    const token = await refreshToken({
      signal: options?.signal,
      quiet: options?.quietRefresh,
    });
    if (token) credential = { token, source: "token_file" };
  }

  // Fail closed locally instead of firing a request we already know will 401.
  // A machine with no stored credential — or a terminal-marked session whose
  // access token is at/near expiry and can no longer be refreshed — would
  // otherwise emit a naked 401 on every hook and daemon call, the request storm
  // this guards against. The second guard also preempts the last ≤60s of a
  // still-valid access token once its refresh is terminally dead; that session
  // is finished regardless, so the only thing lost is a burst of doomed calls.
  // Callers still receive the HttpError(401) they map to a re-auth prompt
  // (hooks fail open), just without the wasted round-trip.
  if (!credential) {
    throw new HttpError(401, AUTH_EXPIRED_MESSAGE);
  }
  if (isTokenExpiringSoon(credential) && isSessionEnded()) {
    throw new HttpError(401, AUTH_EXPIRED_MESSAGE);
  }

  const tokenUsed = credential.token;
  let response = await fetchWithToken(method, path, body, options, tokenUsed);
  if (response.status === 401) {
    const latest = resolveAuthCredential();
    let retryToken = latest?.token !== tokenUsed ? latest?.token : undefined;
    if (!retryToken && latest?.source === "token_file" && !refreshAttempted) {
      refreshAttempted = true;
      retryToken = await refreshToken({ signal: options?.signal, quiet: options?.quietRefresh });
    }
    if (retryToken) {
      _cachedCredential = {
        token: retryToken,
        source: latest?.source === "token_file" ? "token_file" : (latest?.source ?? "token_file"),
      };
      response = await fetchWithToken(method, path, body, options, retryToken);
    }
  }
  return responseValue(response);
}

export function getClient(): CliClient {
  return {
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body, options) => request("POST", path, body, options),
  };
}

/**
 * Resolve one usable bearer generation and pin it for a multi-request operation.
 * A 401 never swaps in a different credential: callers that bind local data to
 * the authenticated tenant must retry the whole preflight under the new token.
 */
export async function getPinnedClient(options: RequestOptions = {}): Promise<CliClient> {
  const siteUrl = getSiteUrl();
  let credential = selectedCredential();
  if (credential && isTokenExpiringSoon(credential)) {
    const token = await refreshToken({
      signal: options.signal,
      quiet: options.quietRefresh,
      siteUrl,
    });
    if (token) {
      credential = { token, source: "token_file" };
    }
  }
  if (!credential || (isTokenExpiringSoon(credential) && isSessionEnded())) {
    throw new HttpError(401, AUTH_EXPIRED_MESSAGE);
  }
  const token = credential.token;
  const pinnedRequest = async (
    method: string,
    path: string,
    body?: unknown,
    requestOptions?: RequestOptions,
  ): Promise<unknown> =>
    responseValue(await fetchWithToken(method, path, body, requestOptions, token, siteUrl));
  return {
    get: (path, requestOptions) => pinnedRequest("GET", path, undefined, requestOptions),
    post: (path, body, requestOptions) => pinnedRequest("POST", path, body, requestOptions),
  };
}

/**
 * Resolve one usable bearer generation for a management operation without a
 * post-response credential retry. A user API-key mint may have reached WorkOS
 * even when its HTTP result is lost, so replaying it under a refreshed token is
 * not safe. Callers must treat a failed mint as uncertain and start a new
 * explicitly authorized operation only after reconciliation.
 */
export async function getPinnedManagementClient(
  options: RequestOptions = {},
): Promise<CliManagementClient> {
  const siteUrl = getSiteUrl();
  let credential = selectedCredential();
  if (credential && isTokenExpiringSoon(credential)) {
    const token = await refreshToken({
      signal: options.signal,
      quiet: options.quietRefresh,
      siteUrl,
    });
    if (token) {
      credential = { token, source: "token_file" };
    }
  }
  if (!credential || (isTokenExpiringSoon(credential) && isSessionEnded())) {
    throw new HttpError(401, AUTH_EXPIRED_MESSAGE);
  }
  const token = credential.token;
  const pinnedRequest = async (
    method: string,
    path: string,
    body?: unknown,
    requestOptions?: RequestOptions,
  ): Promise<unknown> =>
    managementResponseValue(
      await fetchWithToken(method, path, body, requestOptions, token, siteUrl),
    );
  return {
    delete: (path, body, requestOptions) => pinnedRequest("DELETE", path, body, requestOptions),
    get: (path, requestOptions) => pinnedRequest("GET", path, undefined, requestOptions),
    post: (path, body, requestOptions) => pinnedRequest("POST", path, body, requestOptions),
  };
}
