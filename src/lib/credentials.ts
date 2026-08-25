import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { primConfigDirectory } from "./paths.js";
import {
  type WorkosConnectCredentialMetadata,
  parseWorkosConnectCredentialMetadata,
} from "./workos-connect.js";

const CONFIG_DIRECTORY = primConfigDirectory();

export const TOKEN_FILE_PATH = join(CONFIG_DIRECTORY, "token");
export const REFRESH_TOKEN_PATH = join(CONFIG_DIRECTORY, "refresh_token");
export const TOKEN_EXPIRES_PATH = join(CONFIG_DIRECTORY, "token_expires_at");
export const TERMINAL_REFRESH_PATH = join(CONFIG_DIRECTORY, "refresh_terminal");
export const CREDENTIAL_METADATA_PATH = join(CONFIG_DIRECTORY, "credential_metadata.json");
export const CREDENTIAL_FAMILY_PATH = join(CONFIG_DIRECTORY, "credential_family.json");
export const CREDENTIAL_MIGRATION_PATH = join(CONFIG_DIRECTORY, "credential_migration.json");
export const CREDENTIAL_LOCK_PATH = join(CONFIG_DIRECTORY, "credentials.lock");

const MAX_CREDENTIAL_METADATA_BYTES = 4096;
export const CREDENTIAL_MIGRATION_VERSION = 1;
export const CREDENTIAL_MIGRATION_STATE = "family_bound";

export type AuthCredentialSource = "environment" | "token_file";

export interface AuthCredential {
  token: string;
  source: AuthCredentialSource;
}

export interface CredentialResolutionOptions {
  env?: NodeJS.ProcessEnv;
  tokenFilePath?: string;
  refreshTokenPath?: string;
  metadataPath?: string;
  familyPath?: string;
  migrationPath?: string;
}

export type LegacyBrokerCredentialMetadata = Readonly<{
  version: 1;
  family: "legacy_broker";
  accessTokenHash: string;
  refreshTokenHash: string;
}>;

export type StoredCredentialMetadataResolution =
  | Readonly<{ state: "legacy_broker"; metadata?: LegacyBrokerCredentialMetadata }>
  | Readonly<{ state: "workos_connect"; metadata: WorkosConnectCredentialMetadata }>
  | Readonly<{ state: "invalid" }>;

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
  if (!stored) return undefined;
  const metadata = readStoredCredentialMetadata(
    options.metadataPath ?? CREDENTIAL_METADATA_PATH,
    options.familyPath ?? CREDENTIAL_FAMILY_PATH,
    options.migrationPath ?? CREDENTIAL_MIGRATION_PATH,
  );
  if (metadata.state === "legacy_broker") {
    if (metadata.metadata) {
      const refreshToken = readTrimmed(options.refreshTokenPath ?? REFRESH_TOKEN_PATH);
      if (
        !refreshToken ||
        metadata.metadata.accessTokenHash !== credentialFingerprint(stored) ||
        metadata.metadata.refreshTokenHash !== credentialFingerprint(refreshToken)
      ) {
        return undefined;
      }
    }
    return { token: stored, source: "token_file" };
  }
  if (metadata.state === "invalid") return undefined;
  const refreshToken = readTrimmed(options.refreshTokenPath ?? REFRESH_TOKEN_PATH);
  if (
    !refreshToken ||
    metadata.metadata.accessTokenHash !== credentialFingerprint(stored) ||
    metadata.metadata.refreshTokenHash !== credentialFingerprint(refreshToken)
  ) {
    return undefined;
  }
  return { token: stored, source: "token_file" };
}

function credentialFingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function parseLegacyBrokerCredentialMetadata(value: unknown): LegacyBrokerCredentialMetadata {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("credential family is invalid");
  }
  const record = value as Record<string, unknown>;
  if (
    record.version !== 1 ||
    record.family !== "legacy_broker" ||
    typeof record.accessTokenHash !== "string" ||
    typeof record.refreshTokenHash !== "string" ||
    !/^[a-f0-9]{64}$/u.test(record.accessTokenHash) ||
    !/^[a-f0-9]{64}$/u.test(record.refreshTokenHash)
  ) {
    throw new Error("credential family is invalid");
  }
  return {
    version: 1,
    family: "legacy_broker",
    accessTokenHash: record.accessTokenHash,
    refreshTokenHash: record.refreshTokenHash,
  };
}

function readBoundedCredentialJson(path: string): unknown | undefined | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT" ? undefined : null;
  }
  if (Buffer.byteLength(raw, "utf8") > MAX_CREDENTIAL_METADATA_BYTES) return null;
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    return null;
  }
}

function readCredentialFamily(path: string): StoredCredentialMetadataResolution | undefined {
  const parsed = readBoundedCredentialJson(path);
  if (parsed === undefined) return undefined;
  if (parsed === null) return { state: "invalid" };
  try {
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).family === "legacy_broker"
    ) {
      return { state: "legacy_broker", metadata: parseLegacyBrokerCredentialMetadata(parsed) };
    }
    return {
      state: "workos_connect",
      metadata: parseWorkosConnectCredentialMetadata(parsed),
    };
  } catch {
    return { state: "invalid" };
  }
}

export type CredentialMigrationState = "absent" | "valid" | "invalid";

function isCredentialMigrationSentinel(value: unknown): boolean {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    keys.length === 2 &&
    keys[0] === "state" &&
    keys[1] === "version" &&
    record.version === CREDENTIAL_MIGRATION_VERSION &&
    record.state === CREDENTIAL_MIGRATION_STATE
  );
}

/** Read the one-way marker that distinguishes pre-#251 legacy state. */
export function readCredentialMigrationState(
  path: string = CREDENTIAL_MIGRATION_PATH,
): CredentialMigrationState {
  const parsed = readBoundedCredentialJson(path);
  if (parsed === undefined) return "absent";
  return parsed !== null && isCredentialMigrationSentinel(parsed) ? "valid" : "invalid";
}

/** A marker-less credential is legacy only before the v1 migration marker. */
export function readStoredCredentialMetadata(
  metadataPath: string = CREDENTIAL_METADATA_PATH,
  familyPath: string = CREDENTIAL_FAMILY_PATH,
  migrationPath: string = CREDENTIAL_MIGRATION_PATH,
): StoredCredentialMetadataResolution {
  const family = readCredentialFamily(familyPath);
  if (family) return family;
  const parsed = readBoundedCredentialJson(metadataPath);
  if (parsed === undefined) {
    return readCredentialMigrationState(migrationPath) === "absent"
      ? { state: "legacy_broker" }
      : { state: "invalid" };
  }
  if (parsed === null) return { state: "invalid" };
  try {
    return {
      state: "workos_connect",
      metadata: parseWorkosConnectCredentialMetadata(parsed),
    };
  } catch {
    return { state: "invalid" };
  }
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
