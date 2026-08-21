import { readFileSync } from "node:fs";
import { join } from "node:path";
import { primConfigDirectory } from "./paths.js";

const CONFIG_DIRECTORY = primConfigDirectory();

export const TOKEN_FILE_PATH = join(CONFIG_DIRECTORY, "token");
export const REFRESH_TOKEN_PATH = join(CONFIG_DIRECTORY, "refresh_token");
export const TOKEN_EXPIRES_PATH = join(CONFIG_DIRECTORY, "token_expires_at");
export const TERMINAL_REFRESH_PATH = join(CONFIG_DIRECTORY, "refresh_terminal");
export const CREDENTIAL_LOCK_PATH = join(CONFIG_DIRECTORY, "credentials.lock");

export type AuthCredentialSource = "environment" | "token_file";

export interface AuthCredential {
  token: string;
  source: AuthCredentialSource;
}

export interface CredentialResolutionOptions {
  env?: NodeJS.ProcessEnv;
  tokenFilePath?: string;
}

function readTrimmed(path: string): string | undefined {
  try {
    const value = readFileSync(path, "utf8").trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/** Resolve credentials from explicit process state, never repository files. */
export function resolveAuthCredential(
  options: CredentialResolutionOptions = {},
): AuthCredential | undefined {
  const envToken = (options.env ?? process.env).PRIM_TOKEN?.trim();
  if (envToken) return { token: envToken, source: "environment" };

  const stored = readTrimmed(options.tokenFilePath ?? TOKEN_FILE_PATH);
  return stored ? { token: stored, source: "token_file" } : undefined;
}

export function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    if (payload === null || typeof payload !== "object" || Array.isArray(payload)) return undefined;
    return payload as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

export function jwtExpiresAt(token: string): number | undefined {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

export function jwtOrganizationId(token: string): string | undefined {
  const orgId = decodeJwtPayload(token)?.org_id;
  return typeof orgId === "string" && orgId.length > 0 ? orgId : undefined;
}
