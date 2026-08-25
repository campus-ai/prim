import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  CREDENTIAL_MIGRATION_STATE,
  CREDENTIAL_MIGRATION_VERSION,
  jwtExpiresAt,
  jwtOrganizationId,
  resolveAuthCredential,
} from "./credentials.js";

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "prim-credentials-"));
  temporaryDirectories.push(directory);
  return directory;
}

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("credential resolution", () => {
  it("uses one environment-then-token-file priority and trims both sources", () => {
    const directory = temporaryDirectory();
    const tokenFilePath = join(directory, "token");
    writeFileSync(tokenFilePath, " stored-token \n");

    expect(resolveAuthCredential({ env: {}, tokenFilePath })).toEqual({
      token: "stored-token",
      source: "token_file",
    });
    expect(
      resolveAuthCredential({ env: { PRIM_TOKEN: " environment-token " }, tokenFilePath }),
    ).toEqual({
      token: "environment-token",
      source: "environment",
    });
  });

  it("never sources a credential from the current repository's dotenv files", () => {
    const repository = temporaryDirectory();
    mkdirSync(join(repository, "nested"));
    writeFileSync(join(repository, ".env"), "PRIM_TOKEN=attacker-env-token\n");
    writeFileSync(join(repository, ".env.local"), "PRIM_TOKEN=attacker-local-token\n");

    expect(
      resolveAuthCredential({
        env: {},
        tokenFilePath: join(repository, "nested", "missing-token"),
      }),
    ).toBeUndefined();
  });

  it("recognizes marker-less credentials only before the exact migration sentinel", () => {
    const directory = temporaryDirectory();
    const tokenFilePath = join(directory, "token");
    const refreshTokenPath = join(directory, "refresh_token");
    const migrationPath = join(directory, "credential_migration.json");
    writeFileSync(tokenFilePath, "legacy-access\n");
    writeFileSync(refreshTokenPath, "legacy-refresh\n");
    const options = {
      env: {},
      tokenFilePath,
      refreshTokenPath,
      metadataPath: join(directory, "credential_metadata.json"),
      familyPath: join(directory, "credential_family.json"),
      migrationPath,
    };

    expect(resolveAuthCredential(options)).toEqual({
      token: "legacy-access",
      source: "token_file",
    });

    writeFileSync(
      migrationPath,
      JSON.stringify({
        version: CREDENTIAL_MIGRATION_VERSION,
        state: CREDENTIAL_MIGRATION_STATE,
      }),
    );
    expect(resolveAuthCredential(options)).toBeUndefined();

    writeFileSync(
      migrationPath,
      JSON.stringify({
        version: CREDENTIAL_MIGRATION_VERSION + 1,
        state: CREDENTIAL_MIGRATION_STATE,
      }),
    );
    expect(resolveAuthCredential(options)).toBeUndefined();

    writeFileSync(
      migrationPath,
      JSON.stringify({
        version: CREDENTIAL_MIGRATION_VERSION,
        state: CREDENTIAL_MIGRATION_STATE,
        extra: true,
      }),
    );
    expect(resolveAuthCredential(options)).toBeUndefined();

    writeFileSync(migrationPath, "not-json\n");
    expect(resolveAuthCredential(options)).toBeUndefined();
  });
});

describe("shared JWT decoding", () => {
  it("projects expiry and organization from one decoder", () => {
    const token = jwt({ exp: 123, org_id: "org_test" });
    expect(jwtExpiresAt(token)).toBe(123_000);
    expect(jwtOrganizationId(token)).toBe("org_test");
  });

  it("rejects malformed and incorrectly typed claims", () => {
    expect(jwtExpiresAt("not-a-jwt")).toBeUndefined();
    expect(jwtExpiresAt(jwt({ exp: "123" }))).toBeUndefined();
    expect(jwtOrganizationId(jwt({ org_id: 123 }))).toBeUndefined();
    expect(jwtOrganizationId("header.invalid.signature")).toBeUndefined();
  });
});
