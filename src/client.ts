/**
 * REST client for the prim CLI.
 *
 * Calls /api/cli/* endpoints on the Convex site URL with bearer auth.
 * Reads deployment URL from environment or .env.local.
 *
 * Auth priority:
 *   1. PRIM_TOKEN env var
 *   2. ~/.config/prim/token file
 *   3. .env.local PRIM_TOKEN
 *   4. Unauthenticated (will fail with 401)
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

function loadEnvFile(): Record<string, string> {
  const envVars: Record<string, string> = {};
  const candidates = [".env.local", ".env"];

  for (const file of candidates) {
    const filePath = resolve(process.cwd(), file);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      for (const line of content.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith("#")) continue;
        const eqIdx = trimmed.indexOf("=");
        if (eqIdx === -1) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        envVars[key] = value;
      }
    }
  }

  return envVars;
}

/**
 * Path to the stored auth token file.
 */
export const TOKEN_FILE_PATH = join(homedir(), ".config", "prim", "token");

export const REFRESH_TOKEN_PATH = TOKEN_FILE_PATH.replace("/token", "/refresh_token");

/**
 * Resolve an auth token from multiple sources.
 *
 * Priority: PRIM_TOKEN env → ~/.config/prim/token → .env.local PRIM_TOKEN
 * Returns undefined if no token is found (unauthenticated mode).
 */
export function getAuthToken(): string | undefined {
  // 1. Environment variable
  if (process.env.PRIM_TOKEN) {
    return process.env.PRIM_TOKEN;
  }

  // 2. Token file
  if (existsSync(TOKEN_FILE_PATH)) {
    const token = readFileSync(TOKEN_FILE_PATH, "utf-8").trim();
    if (token) {
      return token;
    }
  }

  // 3. .env.local / .env files
  const envVars = loadEnvFile();
  if (envVars.PRIM_TOKEN) {
    return envVars.PRIM_TOKEN;
  }

  return undefined;
}

export function getConvexUrl(): string {
  // 1. Check environment variable
  if (process.env.VITE_CONVEX_URL) {
    return process.env.VITE_CONVEX_URL;
  }

  // 2. Check .env.local / .env files
  const envVars = loadEnvFile();
  if (envVars.VITE_CONVEX_URL) {
    return envVars.VITE_CONVEX_URL;
  }

  throw new Error("VITE_CONVEX_URL not found. Set it in your environment or .env.local file.");
}

export function getSiteUrl(): string {
  return getConvexUrl().replace(".convex.cloud", ".convex.site");
}

/**
 * Attempt to refresh the access token using a stored refresh token.
 * Returns the new access token, or undefined if refresh is not possible.
 */
export async function refreshToken(): Promise<string | undefined> {
  if (!existsSync(REFRESH_TOKEN_PATH)) {
    return undefined;
  }

  const refreshTokenValue = readFileSync(REFRESH_TOKEN_PATH, "utf-8").trim();
  if (!refreshTokenValue) {
    return undefined;
  }

  const siteUrl = getSiteUrl();

  const response = await fetch(`${siteUrl}/mcp/broker/refresh`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshTokenValue }),
  });

  if (!response.ok) {
    return undefined;
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
  };

  if (!data.access_token) {
    return undefined;
  }

  // Save new tokens
  writeFileSync(TOKEN_FILE_PATH, data.access_token, { mode: 0o600 });

  if (data.refresh_token) {
    writeFileSync(REFRESH_TOKEN_PATH, data.refresh_token, { mode: 0o600 });
  }

  return data.access_token;
}

/**
 * Thin REST client wrapping fetch with bearer auth and auto-refresh.
 */
export interface CliClient {
  get(path: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  post(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  patch(path: string, body?: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  delete(path: string, options?: { signal?: AbortSignal }): Promise<unknown>;
}

let _cachedToken: string | undefined;

async function request(
  method: string,
  path: string,
  body?: unknown,
  options?: { signal?: AbortSignal },
): Promise<unknown> {
  const siteUrl = getSiteUrl();
  const url = `${siteUrl}${path}`;

  if (!_cachedToken) {
    _cachedToken = getAuthToken();
  }

  const doFetch = async (token: string | undefined) => {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }

    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: options?.signal,
    });
  };

  let res = await doFetch(_cachedToken);

  // Attempt refresh on 401
  if (res.status === 401) {
    const newToken = await refreshToken();
    if (newToken) {
      _cachedToken = newToken;
      res = await doFetch(newToken);
    }
  }

  if (!res.ok) {
    const errorBody = (await res.json().catch(() => null)) as {
      error?: string;
    } | null;
    throw new Error(errorBody?.error ?? `HTTP ${res.status}`);
  }

  return res.json();
}

export function getClient(): CliClient {
  return {
    get: (path, options) => request("GET", path, undefined, options),
    post: (path, body, options) => request("POST", path, body, options),
    patch: (path, body, options) => request("PATCH", path, body, options),
    delete: (path, options) => request("DELETE", path, undefined, options),
  };
}
