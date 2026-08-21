/** REST client and shared credential store for the prim CLI. */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { atomicWriteFile } from "./lib/atomic-file.js";
import { type FileLockOptions, withFileLock } from "./lib/file-lock.js";
import { terminalSafeLine } from "./lib/terminal-safe.js";

const CONFIG_DIR_MODE = 0o700;
const CREDENTIAL_FILE_MODE = 0o600;
const REFRESH_THRESHOLD_MS = 60_000;
const DEFAULT_API_URL = "https://api.getprimitive.ai";
const AUTH_EXPIRED_MESSAGE = "Authentication expired. Run `prim auth login` to re-authenticate.";

function loadEnvFile(cwd = process.cwd()): Record<string, string> {
  const envVars: Record<string, string> = {};
  for (const file of [".env.local", ".env"]) {
    const filePath = resolve(cwd, file);
    if (!existsSync(filePath)) continue;
    const content = readFileSync(filePath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      envVars[trimmed.slice(0, eqIdx).trim()] = trimmed.slice(eqIdx + 1).trim();
    }
  }
  return envVars;
}

export const TOKEN_FILE_PATH = join(homedir(), ".config", "prim", "token");
export const REFRESH_TOKEN_PATH = join(dirname(TOKEN_FILE_PATH), "refresh_token");
export const TOKEN_EXPIRES_PATH = join(dirname(TOKEN_FILE_PATH), "token_expires_at");
export const TERMINAL_REFRESH_PATH = join(dirname(TOKEN_FILE_PATH), "refresh_terminal");
export const CREDENTIAL_LOCK_PATH = join(dirname(TOKEN_FILE_PATH), "credentials.lock");

export type AuthCredentialSource = "environment" | "token_file" | "env_file";

export interface AuthCredential {
  token: string;
  source: AuthCredentialSource;
}

export interface StoredCredentials {
  accessToken: string;
  refreshToken: string;
  expiresIn?: number;
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

/** Resolve the selected credential without conflating fixed tokens with browser OAuth. */
export function resolveAuthCredential(): AuthCredential | undefined {
  if (process.env.PRIM_TOKEN) {
    return { token: process.env.PRIM_TOKEN, source: "environment" };
  }

  const stored = readTrimmed(TOKEN_FILE_PATH);
  if (stored) {
    return { token: stored, source: "token_file" };
  }

  const envToken = loadEnvFile().PRIM_TOKEN;
  return envToken ? { token: envToken, source: "env_file" } : undefined;
}

/** Backwards-compatible token-only resolver. */
export function getAuthToken(): string | undefined {
  return resolveAuthCredential()?.token;
}

export function getSiteUrl(): string {
  return getSiteUrlForCwd(process.cwd(), process.env.PRIM_API_URL);
}

/** Resolve a caller's deployment using the CLI's existing cwd/env precedence. */
export function getSiteUrlForCwd(cwd: string, primApiUrl?: string): string {
  if (primApiUrl) return primApiUrl;
  return loadEnvFile(cwd).PRIM_API_URL ?? DEFAULT_API_URL;
}

function getJwtExpiry(token: string): number | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as { exp?: number };
    return payload.exp ? payload.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
}

function expiresAtFor(token: string, expiresIn?: number): number | undefined {
  return expiresIn === undefined ? getJwtExpiry(token) : Date.now() + expiresIn * 1000;
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

  // Access is the commit marker. Readers cannot observe a new access token
  // paired with the previous one-use refresh generation.
  atomicWrite(REFRESH_TOKEN_PATH, `${refreshToken}\n`);
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
    clearTerminalFingerprint();
    atomicWrite(TOKEN_FILE_PATH, `${value}\n`);
    _cachedCredential = { token: value, source: "token_file" };
  }, options);
}

export interface ClearStoredCredentialsOptions extends CredentialLockOptions {
  beforeClear?: (refreshToken: string | undefined) => Promise<void> | void;
}

/** Revoke/inspect and delete one coherent credential generation under one lock. */
export async function clearStoredCredentials(
  options: ClearStoredCredentialsOptions = {},
): Promise<boolean> {
  const { beforeClear, ...lockOptions } = options;
  return withCredentialLock(async () => {
    const refreshToken = readTrimmed(REFRESH_TOKEN_PATH);
    let callbackError: unknown;
    try {
      await beforeClear?.(refreshToken);
    } catch (error) {
      callbackError = error;
    }

    let removed = false;
    for (const path of [
      TOKEN_FILE_PATH,
      REFRESH_TOKEN_PATH,
      TOKEN_EXPIRES_PATH,
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
  const statusText = terminalSafeLine(response.statusText).slice(0, 120);
  const safeDetail = terminalSafeLine(detail).slice(0, 200);
  process.stderr.write(
    `[prim] token refresh rejected by broker: ${response.status}${
      statusText ? ` ${statusText}` : ""
    }${safeDetail ? ` — ${safeDetail}` : ""}\n`,
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

      const response = await fetch(`${getSiteUrl()}/mcp/broker/refresh`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ refresh_token: currentGeneration }),
        signal: options.signal,
      });

      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        // An older uncoordinated client could have replaced the files while the
        // request was in flight. Never poison that newer generation.
        if (
          isTerminalRefreshResponse(response, detail) &&
          readTrimmed(REFRESH_TOKEN_PATH) === currentGeneration
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

      let data: unknown;
      try {
        data = await response.json();
      } catch {
        // A 2xx means the one-use generation may have been consumed. Fail
        // closed rather than replaying it after a malformed response.
        if (readTrimmed(REFRESH_TOKEN_PATH) === currentGeneration) {
          writeTerminalFingerprint(currentGeneration);
        }
        return undefined;
      }
      const record =
        typeof data === "object" && data !== null && !Array.isArray(data)
          ? (data as Record<string, unknown>)
          : undefined;
      const accessToken =
        typeof record?.access_token === "string" ? record.access_token.trim() : "";
      const replacementRefreshToken =
        typeof record?.refresh_token === "string" ? record.refresh_token.trim() : "";
      // WorkOS rotation is optional: a successful refresh may return the SAME
      // refresh token (AuthKit: "Refresh tokens may be rotated after use").
      // Require both fields, but accept an unchanged token — poisoning a
      // same-value replacement would strand a session the broker still honors.
      if (!(accessToken && replacementRefreshToken)) {
        if (readTrimmed(REFRESH_TOKEN_PATH) === currentGeneration) {
          writeTerminalFingerprint(currentGeneration);
        }
        return undefined;
      }

      commitCredentialsUnlocked({
        accessToken,
        refreshToken: replacementRefreshToken,
        expiresIn:
          typeof record?.expires_in === "number" && Number.isFinite(record.expires_in)
            ? record.expires_in
            : undefined,
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

export interface CliClient {
  get(path: string, options?: RequestOptions): Promise<unknown>;
  post(path: string, body?: unknown, options?: RequestOptions): Promise<unknown>;
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

async function request(
  method: string,
  path: string,
  body?: unknown,
  options?: RequestOptions,
): Promise<unknown> {
  const url = `${getSiteUrl()}${path}`;
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

  const doFetch = (token: string | undefined) => {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: options?.signal,
    });
  };

  const tokenUsed = credential?.token;
  let response = await doFetch(tokenUsed);
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
      response = await doFetch(retryToken);
    }
  }

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

export function getClient(): CliClient {
  return {
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body, options) => request("POST", path, body, options),
  };
}
