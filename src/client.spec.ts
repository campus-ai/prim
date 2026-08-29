import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedHome = vi.hoisted(() => ({ value: "" }));
const renamedCredentialPaths = vi.hoisted(() => [] as string[]);
const credentialStoreOperations = vi.hoisted(() => [] as string[]);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockedHome.value };
});

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync: (
      source: Parameters<typeof actual.renameSync>[0],
      destination: Parameters<typeof actual.renameSync>[1],
    ) => {
      renamedCredentialPaths.push(String(destination));
      credentialStoreOperations.push(`write:${String(destination)}`);
      actual.renameSync(source, destination);
    },
    rmSync: (...args: Parameters<typeof actual.rmSync>) => {
      credentialStoreOperations.push(`remove:${String(args[0])}`);
      actual.rmSync(...args);
    },
  };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function jwt(payload: unknown): string {
  return `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`;
}

async function eventually(assertion: () => void, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      assertion();
      return;
    } catch (error) {
      if (Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

describe("client credential store", () => {
  const originalEnv = { ...process.env };
  let home: string;
  let config: string;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
    Reflect.deleteProperty(process.env, "PRIM_TOKEN");
    Reflect.deleteProperty(process.env, "PRIM_API_URL");
    Reflect.deleteProperty(process.env, "PRIM_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    renamedCredentialPaths.length = 0;
    credentialStoreOperations.length = 0;
    home = mkdtempSync(join(tmpdir(), "prim-client-test-"));
    mockedHome.value = home;
    config = join(home, ".config", "prim");
    mkdirSync(config, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it("reports the selected credential source and preserves source priority", async () => {
    writeFileSync(join(config, "token"), "stored-token\n");
    const { resolveAuthCredential } = await import("./client.js");
    expect(resolveAuthCredential()).toEqual({ token: "stored-token", source: "token_file" });

    process.env.PRIM_TOKEN = "environment-token";
    expect(resolveAuthCredential()).toEqual({
      token: "environment-token",
      source: "environment",
    });
  });

  it("uses only an explicit API URL and ignores repository dotenv files", async () => {
    const repo = join(home, "repo");
    mkdirSync(repo);
    writeFileSync(join(repo, ".env.local"), "PRIM_API_URL=https://local.example.test\n");
    writeFileSync(join(repo, ".env"), "PRIM_API_URL=https://env.example.test\n");
    const { getSiteUrlForEnvironment } = await import("./client.js");

    expect(getSiteUrlForEnvironment("https://shell.example.test")).toBe(
      "https://shell.example.test",
    );
    expect(getSiteUrlForEnvironment("")).toBe("https://api.getprimitive.ai");
  });

  it("uses PRIM_CONFIG_DIR for every credential artifact", async () => {
    const explicitConfig = join(home, "private-config");
    process.env.PRIM_CONFIG_DIR = explicitConfig;
    vi.resetModules();
    const client = await import("./client.js");

    expect(client.TOKEN_FILE_PATH).toBe(join(explicitConfig, "token"));
    expect(client.REFRESH_TOKEN_PATH).toBe(join(explicitConfig, "refresh_token"));
    expect(client.CREDENTIAL_FAMILY_PATH).toBe(join(explicitConfig, "credential_family.json"));
    expect(client.CREDENTIAL_MIGRATION_PATH).toBe(
      join(explicitConfig, "credential_migration.json"),
    );
    expect(client.CREDENTIAL_LOCK_PATH).toBe(join(explicitConfig, "credentials.lock"));
  });

  it("does not use disk refresh state for an environment credential", async () => {
    process.env.PRIM_TOKEN = "fixed-token";
    writeFileSync(join(config, "token"), "browser-access\n");
    writeFileSync(join(config, "refresh_token"), "browser-refresh\n");
    writeFileSync(join(config, "token_expires_at"), "0\n");
    writeFileSync(
      join(config, "refresh_terminal"),
      `${createHash("sha256").update("browser-refresh").digest("hex")}\n`,
    );
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse({ error: "expired" }, 401)));
    vi.stubGlobal("fetch", fetchMock);

    const { HttpError, getClient, isSessionEnded } = await import("./client.js");
    expect(isSessionEnded()).toBe(false);
    await expect(getClient().get("/api/cli/auth/status")).rejects.toBeInstanceOf(HttpError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("/mcp/broker/refresh");
  });

  it("preserves a structured non-2xx response body on HttpError", async () => {
    process.env.PRIM_TOKEN = "fixed-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(jsonResponse({ status: "stale_review" }, 409))),
    );
    const { getClient } = await import("./client.js");

    await expect(getClient().post("/api/cli/decisions/repairs/resolve", {})).rejects.toMatchObject({
      status: 409,
      message: "HTTP 409",
      body: { status: "stale_review" },
    });
  });

  it("uses a generic message and null body for a non-JSON HTTP failure", async () => {
    process.env.PRIM_TOKEN = "fixed-token";
    vi.stubGlobal(
      "fetch",
      vi.fn(() => Promise.resolve(new Response("upstream unavailable", { status: 502 }))),
    );
    const { getClient } = await import("./client.js");

    await expect(getClient().get("/api/cli/decisions/repairs")).rejects.toMatchObject({
      status: 502,
      message: "HTTP 502",
      body: null,
    });
  });

  it("pins capture preflight and delivery to one credential and deployment", async () => {
    process.env.PRIM_TOKEN = "token-a";
    process.env.PRIM_API_URL = "https://api-a.example.test";
    const calls: Array<{ token: string | null; url: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((input: string | URL | Request, init?: RequestInit) => {
        calls.push({
          token: new Headers(init?.headers).get("Authorization"),
          url: String(input),
        });
        if (String(input).endsWith("/status")) {
          // A concurrent credential/deployment change must not redirect the
          // operation after the organization proof has started.
          process.env.PRIM_TOKEN = "token-b";
          process.env.PRIM_API_URL = "https://api-b.example.test";
          return Promise.resolve(jsonResponse({ authenticated: true }));
        }
        return Promise.resolve(jsonResponse({ disposition: "persisted" }));
      }),
    );
    const { getPinnedClient } = await import("./client.js");
    const client = await getPinnedClient();

    await client.get("/status");
    await client.post("/deliver", { batch: [] });

    expect(calls).toEqual([
      { token: "Bearer token-a", url: "https://api-a.example.test/status" },
      { token: "Bearer token-a", url: "https://api-a.example.test/deliver" },
    ]);
  });

  it("never retries a pinned capture request after a rejected response", async () => {
    process.env.PRIM_TOKEN = "token-a";
    const fetchMock = vi.fn(() => {
      process.env.PRIM_TOKEN = "token-b";
      return Promise.resolve(jsonResponse({ error: "authentication_required" }, 401));
    });
    vi.stubGlobal("fetch", fetchMock);
    const { getPinnedClient } = await import("./client.js");
    const client = await getPinnedClient();

    await expect(client.post("/deliver", { batch: [] })).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(new Headers(fetchMock.mock.calls[0]?.[1]?.headers).get("Authorization")).toBe(
      "Bearer token-a",
    );
  });

  it("pins management mutations and never retries a mint after a 401 response", async () => {
    process.env.PRIM_TOKEN = "fixed-token";
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: "authentication_required" }, 401)),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getPinnedManagementClient } = await import("./client.js");
    const client = await getPinnedManagementClient();

    await expect(
      client.post("/api/cli/auth/api-keys", {
        requestId: "a".repeat(64),
        name: "Primitive CLI",
      }),
    ).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("sends management revocation as one pinned DELETE with a JSON receipt", async () => {
    process.env.PRIM_TOKEN = "fixed-token";
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ apiKeyId: "api_key_example123", revoked: true })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { getPinnedManagementClient } = await import("./client.js");
    const client = await getPinnedManagementClient();

    await expect(
      client.delete("/api/cli/auth/api-keys/api_key_example123", {
        requestId: "b".repeat(64),
      }),
    ).resolves.toEqual({ apiKeyId: "api_key_example123", revoked: true });
    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.getprimitive.ai/api/cli/auth/api-keys/api_key_example123",
      expect.objectContaining({
        method: "DELETE",
        headers: {
          Authorization: "Bearer fixed-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ requestId: "b".repeat(64) }),
      }),
    );
  });

  it("rejects oversized and non-UTF-8 management responses", async () => {
    process.env.PRIM_TOKEN = "fixed-token";
    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response("{}", {
          headers: { "Content-Length": String(2 * 1024 * 1024 + 1) },
        }),
      )
      .mockResolvedValueOnce(
        new Response(new Uint8Array([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xc3, 0x28, 0x22, 0x7d])),
      );
    vi.stubGlobal("fetch", fetchMock);
    const { CliManagementResponseError, getPinnedManagementClient } = await import("./client.js");
    const client = await getPinnedManagementClient();

    await expect(client.get("/api/cli/auth/api-keys")).rejects.toBeInstanceOf(
      CliManagementResponseError,
    );
    await expect(client.get("/api/cli/auth/api-keys")).rejects.toBeInstanceOf(
      CliManagementResponseError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when no expiry metadata exists", async () => {
    const { getTokenExpiresAt } = await import("./client.js");
    expect(getTokenExpiresAt()).toBeUndefined();
  });

  it("commits refresh, a hash-bound legacy family, expiry, and access", async () => {
    const {
      CREDENTIAL_FAMILY_PATH,
      TOKEN_EXPIRES_PATH,
      TOKEN_FILE_PATH,
      REFRESH_TOKEN_PATH,
      commitCredentials,
    } = await import("./client.js");
    await commitCredentials({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 120,
    });

    expect(readFileSync(REFRESH_TOKEN_PATH, "utf8").trim()).toBe("new-refresh");
    expect(readFileSync(TOKEN_FILE_PATH, "utf8").trim()).toBe("new-access");
    expect(JSON.parse(readFileSync(CREDENTIAL_FAMILY_PATH, "utf8"))).toMatchObject({
      version: 1,
      family: "legacy_broker",
      accessTokenHash: createHash("sha256").update("new-access").digest("hex"),
      refreshTokenHash: createHash("sha256").update("new-refresh").digest("hex"),
    });
    expect(Number(readFileSync(TOKEN_EXPIRES_PATH, "utf8"))).toBeGreaterThan(Date.now());
    for (const path of [
      CREDENTIAL_FAMILY_PATH,
      REFRESH_TOKEN_PATH,
      TOKEN_FILE_PATH,
      TOKEN_EXPIRES_PATH,
    ]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(renamedCredentialPaths).toEqual([
      REFRESH_TOKEN_PATH,
      CREDENTIAL_FAMILY_PATH,
      TOKEN_EXPIRES_PATH,
      TOKEN_FILE_PATH,
    ]);
    expect(readdirSync(config).some((name) => name.endsWith(".tmp"))).toBe(false);
  });

  it("binds Connect metadata to the refresh generation and refreshes at the frozen issuer", async () => {
    const client = await import("./client.js");
    await client.commitCredentials({
      accessToken: "connect-access",
      refreshToken: "connect-refresh",
      expiresIn: 300,
      metadata: {
        version: 1,
        family: "workos_connect",
        issuer: "https://auth.example.test",
        clientId: "client_cli",
      },
    });
    const stored = JSON.parse(readFileSync(client.CREDENTIAL_METADATA_PATH, "utf8")) as Record<
      string,
      unknown
    >;
    expect(stored).toEqual({
      version: 1,
      family: "workos_connect",
      issuer: "https://auth.example.test",
      clientId: "client_cli",
      accessTokenHash: createHash("sha256").update("connect-access").digest("hex"),
      refreshTokenHash: createHash("sha256").update("connect-refresh").digest("hex"),
    });
    expect(JSON.parse(readFileSync(client.CREDENTIAL_FAMILY_PATH, "utf8"))).toEqual(stored);
    expect(JSON.parse(readFileSync(client.CREDENTIAL_MIGRATION_PATH, "utf8"))).toEqual({
      version: 1,
      state: "family_bound",
    });
    expect(statSync(client.CREDENTIAL_METADATA_PATH).mode & 0o777).toBe(0o600);
    expect(statSync(client.CREDENTIAL_FAMILY_PATH).mode & 0o777).toBe(0o600);
    expect(statSync(client.CREDENTIAL_MIGRATION_PATH).mode & 0o777).toBe(0o600);
    expect(renamedCredentialPaths.slice(0, 6)).toEqual([
      client.CREDENTIAL_MIGRATION_PATH,
      client.CREDENTIAL_FAMILY_PATH,
      client.CREDENTIAL_METADATA_PATH,
      client.REFRESH_TOKEN_PATH,
      client.TOKEN_EXPIRES_PATH,
      client.TOKEN_FILE_PATH,
    ]);

    const fetchMock = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 300,
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "unrotated-access",
          expires_in: 300,
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBe("rotated-access");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("https://auth.example.test/oauth2/token");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(String(init?.body)).toBe(
      "grant_type=refresh_token&refresh_token=connect-refresh&client_id=client_cli",
    );
    expect(readFileSync(client.REFRESH_TOKEN_PATH, "utf8").trim()).toBe("rotated-refresh");
    expect(JSON.parse(readFileSync(client.CREDENTIAL_METADATA_PATH, "utf8")).refreshTokenHash).toBe(
      createHash("sha256").update("rotated-refresh").digest("hex"),
    );
    expect(JSON.parse(readFileSync(client.CREDENTIAL_FAMILY_PATH, "utf8")).refreshTokenHash).toBe(
      createHash("sha256").update("rotated-refresh").digest("hex"),
    );

    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBe(
      "unrotated-access",
    );
    expect(readFileSync(client.REFRESH_TOKEN_PATH, "utf8").trim()).toBe("rotated-refresh");
    expect(JSON.parse(readFileSync(client.CREDENTIAL_METADATA_PATH, "utf8")).refreshTokenHash).toBe(
      createHash("sha256").update("rotated-refresh").digest("hex"),
    );
  });

  it("keeps a Connect refresh out of the broker after legacy metadata loss", async () => {
    const client = await import("./client.js");
    await client.commitCredentials({
      accessToken: jwt({ aud: "client_cli" }),
      refreshToken: "connect-refresh",
      expiresIn: 300,
      metadata: {
        version: 1,
        family: "workos_connect",
        issuer: "https://auth.example.test",
        clientId: "client_cli",
      },
    });
    rmSync(client.CREDENTIAL_METADATA_PATH);
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 300,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBe("rotated-access");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://auth.example.test/oauth2/token",
      expect.objectContaining({ method: "POST" }),
    );
    expect(String(fetchMock.mock.calls[0]?.[0])).not.toContain("/mcp/broker/refresh");
  });

  it("reports only a Connect error code, never failed-response secrets", async () => {
    const client = await import("./client.js");
    await client.commitCredentials({
      accessToken: "connect-access",
      refreshToken: "connect-refresh",
      metadata: {
        version: 1,
        family: "workos_connect",
        issuer: "https://auth.example.test",
        clientId: "client_cli",
      },
    });
    const secret = "should-not-reach-stderr";
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse(
            {
              error: "invalid_grant",
              error_description: `refresh_token=${secret}`,
              access_token: secret,
              refresh_token: secret,
            },
            400,
          ),
        ),
      ),
    );
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    await expect(client.refreshToken({ force: true })).resolves.toBeUndefined();

    const rendered = String(stderr.mock.calls[0]?.[0]);
    expect(rendered).toContain("WorkOS Connect: 400 — invalid_grant");
    expect(rendered).not.toContain(secret);
    expect(client.isSessionEnded()).toBe(true);
  });

  it("fails closed when a Connect sentinel survives loss of both family markers", async () => {
    const client = await import("./client.js");
    await client.commitCredentials({
      accessToken: jwt({ aud: "client_cli" }),
      refreshToken: "connect-refresh",
      expiresIn: 300,
      metadata: {
        version: 1,
        family: "workos_connect",
        issuer: "https://auth.example.test",
        clientId: "client_cli",
      },
    });
    rmSync(client.CREDENTIAL_FAMILY_PATH);
    rmSync(client.CREDENTIAL_METADATA_PATH);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
    expect(client.resolveAuthCredential()).toBeUndefined();
    let wouldBrokerRevoke = false;
    await client.clearStoredCredentials({
      beforeClear: (refreshToken, metadata) => {
        wouldBrokerRevoke = Boolean(refreshToken && metadata.state === "legacy_broker");
        expect(metadata).toEqual({ state: "invalid" });
      },
    });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(wouldBrokerRevoke).toBe(false);
    expect(readdirSync(config)).toEqual([]);
  });

  it("migrates a pre-sentinel legacy WorkOS client JWT before broker refresh", async () => {
    writeFileSync(join(config, "token"), `${jwt({ aud: "client_cli" })}\n`);
    writeFileSync(join(config, "refresh_token"), "legacy-refresh\n");
    process.env.PRIM_API_URL = "https://legacy.example.test";
    const fetchMock = vi.fn(() => {
      expect(
        JSON.parse(readFileSync(join(config, "credential_family.json"), "utf8")),
      ).toMatchObject({
        family: "legacy_broker",
        accessTokenHash: createHash("sha256")
          .update(jwt({ aud: "client_cli" }))
          .digest("hex"),
        refreshTokenHash: createHash("sha256").update("legacy-refresh").digest("hex"),
      });
      expect(JSON.parse(readFileSync(join(config, "credential_migration.json"), "utf8"))).toEqual({
        version: 1,
        state: "family_bound",
      });
      return Promise.resolve(
        jsonResponse({
          access_token: "rotated-access",
          refresh_token: "rotated-refresh",
          expires_in: 300,
        }),
      );
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = await import("./client.js");
    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBe("rotated-access");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://legacy.example.test/mcp/broker/refresh",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refresh_token: "legacy-refresh" }),
      }),
    );
  });

  it("fails closed for a malformed sentinel during refresh and clear", async () => {
    writeFileSync(join(config, "token"), `${jwt({ aud: "client_cli" })}\n`);
    writeFileSync(join(config, "refresh_token"), "ambiguous-refresh\n");
    writeFileSync(join(config, "credential_migration.json"), "not-json\n");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = await import("./client.js");
    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
    let wouldBrokerRevoke = false;
    await client.clearStoredCredentials({
      beforeClear: (refreshToken, metadata) => {
        wouldBrokerRevoke = Boolean(refreshToken && metadata.state === "legacy_broker");
        expect(metadata).toEqual({ state: "invalid" });
      },
    });

    expect(fetchMock).not.toHaveBeenCalled();
    expect(wouldBrokerRevoke).toBe(false);
    expect(readdirSync(config)).toEqual([]);
  });

  it("fails closed before I/O when Connect metadata is malformed or stale", async () => {
    writeFileSync(join(config, "token"), "newer-access\n");
    writeFileSync(join(config, "refresh_token"), "newer-refresh\n");
    writeFileSync(
      join(config, "credential_metadata.json"),
      JSON.stringify({
        version: 1,
        family: "workos_connect",
        issuer: "https://auth.example.test",
        clientId: "client_cli",
        accessTokenHash: createHash("sha256").update("newer-access").digest("hex"),
        refreshTokenHash: createHash("sha256").update("older-refresh").digest("hex"),
      }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const client = await import("./client.js");
    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    writeFileSync(join(config, "credential_metadata.json"), "not-json\n");
    vi.resetModules();
    const reloaded = await import("./client.js");
    await expect(reloaded.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["metadata", false, false],
    ["refresh", true, false],
    ["expiry", true, true],
  ] as const)(
    "fails closed after a Connect login crash following the %s write",
    async (_stage, replaceRefresh, replaceExpiry) => {
      writeFileSync(join(config, "token"), "old-access\n");
      writeFileSync(join(config, "refresh_token"), "old-refresh\n");
      writeFileSync(join(config, "token_expires_at"), "1\n");
      writeFileSync(
        join(config, "credential_metadata.json"),
        `${JSON.stringify({
          version: 1,
          family: "workos_connect",
          issuer: "https://auth.example.test",
          clientId: "client_cli",
          accessTokenHash: createHash("sha256").update("new-access").digest("hex"),
          refreshTokenHash: createHash("sha256").update("new-refresh").digest("hex"),
        })}\n`,
      );
      if (replaceRefresh) writeFileSync(join(config, "refresh_token"), "new-refresh\n");
      if (replaceExpiry)
        writeFileSync(join(config, "token_expires_at"), `${Date.now() + 300_000}\n`);
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      const client = await import("./client.js");
      expect(client.resolveAuthCredential()).toBeUndefined();
      await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
      await expect(client.getClient().get("/api/cli/auth/status")).rejects.toBeInstanceOf(
        client.HttpError,
      );
      expect(fetchMock).not.toHaveBeenCalled();
    },
  );

  it("accepts a fully committed Connect generation bound to both token hashes", async () => {
    const accessToken = "new-access";
    const refreshToken = "new-refresh";
    writeFileSync(join(config, "token"), `${accessToken}\n`);
    writeFileSync(join(config, "refresh_token"), `${refreshToken}\n`);
    writeFileSync(
      join(config, "credential_metadata.json"),
      `${JSON.stringify({
        version: 1,
        family: "workos_connect",
        issuer: "https://auth.example.test",
        clientId: "client_cli",
        accessTokenHash: createHash("sha256").update(accessToken).digest("hex"),
        refreshTokenHash: createHash("sha256").update(refreshToken).digest("hex"),
      })}\n`,
    );

    const client = await import("./client.js");
    expect(client.resolveAuthCredential()).toEqual({ token: accessToken, source: "token_file" });
  });

  it("persists only a terminal refresh fingerprint and suppresses replay after reload", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "secret-refresh\n");
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse(
          { error: "invalid_grant", error_description: "Session has already ended." },
          400,
        ),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const first = await import("./client.js");
    await expect(first.refreshToken({ quiet: true })).resolves.toBeUndefined();
    expect(first.isSessionEnded()).toBe(true);
    const marker = readFileSync(first.TERMINAL_REFRESH_PATH, "utf8").trim();
    expect(marker).toMatch(/^[a-f0-9]{64}$/);
    expect(marker).not.toContain("secret-refresh");

    vi.resetModules();
    const afterReload = await import("./client.js");
    expect(afterReload.isSessionEnded()).toBe(true);
    await expect(afterReload.refreshToken({ quiet: true })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    { access_token: { unexpected: true }, refresh_token: "replacement" },
    { access_token: "replacement", refresh_token: "   " },
  ])("fails closed for malformed successful broker credentials", async (brokerBody) => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "consumed-refresh\n");
    const fetchMock = vi.fn(() => Promise.resolve(jsonResponse(brokerBody)));
    vi.stubGlobal("fetch", fetchMock);

    const client = await import("./client.js");
    await expect(client.refreshToken({ quiet: true })).resolves.toBeUndefined();
    expect(client.isSessionEnded()).toBe(true);
    await expect(client.refreshToken({ quiet: true })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("adopts a fresh access token when WorkOS declines to rotate", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "consumed-refresh\n");
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        jsonResponse({
          access_token: "rotated-access",
          refresh_token: "consumed-refresh",
          expires_in: 300,
        }),
      ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = await import("./client.js");
    await expect(client.refreshToken({ quiet: true })).resolves.toBe("rotated-access");
    expect(client.isSessionEnded()).toBe(false);
    expect(readFileSync(client.TOKEN_FILE_PATH, "utf8").trim()).toBe("rotated-access");
    expect(readFileSync(client.REFRESH_TOKEN_PATH, "utf8").trim()).toBe("consumed-refresh");
  });

  it("trims a complete successful broker generation before committing", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "old-refresh\n");
    vi.stubGlobal(
      "fetch",
      vi.fn(() =>
        Promise.resolve(
          jsonResponse({
            access_token: "  new-access  ",
            refresh_token: "  new-refresh  ",
            expires_in: 300,
          }),
        ),
      ),
    );

    const client = await import("./client.js");
    await expect(client.refreshToken({ quiet: true })).resolves.toBe("new-access");
    expect(readFileSync(client.TOKEN_FILE_PATH, "utf8").trim()).toBe("new-access");
    expect(readFileSync(client.REFRESH_TOKEN_PATH, "utf8").trim()).toBe("new-refresh");
    expect(JSON.parse(readFileSync(client.CREDENTIAL_FAMILY_PATH, "utf8"))).toMatchObject({
      family: "legacy_broker",
      accessTokenHash: createHash("sha256").update("new-access").digest("hex"),
      refreshTokenHash: createHash("sha256").update("new-refresh").digest("hex"),
    });
  });

  it("uses an old writer's winner only for the in-flight legacy retry", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "old-refresh\n");
    let reject!: () => void;
    const response = new Promise<Response>((resolve) => {
      reject = () => resolve(jsonResponse({ error: "Invalid or expired refresh token" }, 401));
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(() => response),
    );

    const client = await import("./client.js");
    const refreshing = client.refreshToken({ quiet: true });
    await eventually(() => expect(fetch).toHaveBeenCalledTimes(1));
    // An old writer can replace raw files while this first current-version
    // refresh is in flight. Its replacement is usable once, but never bound
    // as broker state: it could otherwise be a Connect-shaped generation.
    const winnerAccess = jwt({ aud: "client_cli" });
    writeFileSync(client.REFRESH_TOKEN_PATH, "winner-refresh\n");
    writeFileSync(client.TOKEN_FILE_PATH, `${winnerAccess}\n`);
    reject();

    await expect(refreshing).resolves.toBe(winnerAccess);
    expect(client.isSessionEnded()).toBe(false);
    expect(client.resolveAuthCredential()).toBeUndefined();
    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(1);

    let wouldBrokerRevoke = false;
    await client.clearStoredCredentials({
      beforeClear: (refreshToken, metadata) => {
        wouldBrokerRevoke = Boolean(refreshToken && metadata.state === "legacy_broker");
        expect(metadata).toEqual({ state: "invalid" });
      },
    });
    expect(wouldBrokerRevoke).toBe(false);
  });

  it("keeps a noncanonical intermediary 401 retryable", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "old-refresh\n");
    const fetchMock = vi.fn(() =>
      Promise.resolve(jsonResponse({ error: "upstream_authentication_required" }, 401)),
    );
    vi.stubGlobal("fetch", fetchMock);

    const client = await import("./client.js");
    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
    expect(client.isSessionEnded()).toBe(false);
    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("sanitizes broker refresh diagnostics without changing quiet refreshes", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "old-refresh\n");
    const esc = String.fromCharCode(0x1b);
    const carriageReturn = String.fromCharCode(0x0d);
    const lineFeed = String.fromCharCode(0x0a);
    const bell = String.fromCharCode(0x07);
    const bidiOverride = String.fromCodePoint(0x202e);
    const unsafeStatus = `Bad${carriageReturn}${lineFeed}${esc}[2J${bidiOverride} Request`;
    const unsafeDetail = `broker${carriageReturn}${lineFeed}${esc}]52;c;clipboard${bell}${esc}[31m${bidiOverride} failure`;
    const brokerFailure = {
      ok: false,
      status: 400,
      statusText: unsafeStatus,
      text: async () => unsafeDetail,
    } as unknown as Response;
    const fetchMock = vi.fn(() => Promise.resolve(brokerFailure));
    vi.stubGlobal("fetch", fetchMock);
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const client = await import("./client.js");
    await expect(client.refreshToken({ force: true, quiet: true })).resolves.toBeUndefined();
    expect(stderr).not.toHaveBeenCalled();

    await expect(client.refreshToken({ force: true })).resolves.toBeUndefined();
    const rendered = String(stderr.mock.calls[0]?.[0]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(rendered).toContain("[prim] token refresh rejected by broker: 400 Bad [2J Request");
    expect(rendered).toContain("broker ]52;c;clipboard[31m failure");
    expect(rendered).not.toContain(esc);
    expect(rendered).not.toContain(bell);
    expect(rendered).not.toContain(carriageReturn);
    expect(rendered).not.toContain(bidiOverride);
    expect(rendered.split(lineFeed)).toHaveLength(2);
  });

  it("never performs proactive and reactive rotation twice in one request", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "old-refresh\n");
    writeFileSync(join(config, "token_expires_at"), "0\n");
    let brokerCalls = 0;
    let apiCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        if (String(url).endsWith("/mcp/broker/refresh")) {
          brokerCalls += 1;
          return Promise.resolve(
            jsonResponse({
              access_token: "rotated-access",
              refresh_token: "rotated-refresh",
              expires_in: 300,
            }),
          );
        }
        apiCalls += 1;
        return Promise.resolve(jsonResponse({ error: "rejected" }, 401));
      }),
    );

    const { getClient } = await import("./client.js");
    await expect(getClient().get("/api/cli/test")).rejects.toMatchObject({ status: 401 });
    expect(brokerCalls).toBe(1);
    expect(apiCalls).toBe(1);
  });

  it("fails closed locally when no credential is available", async () => {
    // A machine that never logged in would otherwise POST a naked request per
    // hook/daemon call; fail fast so callers get the re-auth signal for free.
    process.env.PRIM_TOKEN = undefined;
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getClient } = await import("./client.js");
    await expect(getClient().get("/api/cli/test")).rejects.toMatchObject({ status: 401 });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed locally on a terminal session with an expired token", async () => {
    writeFileSync(join(config, "token"), "stale-access\n");
    writeFileSync(join(config, "refresh_token"), "dead-refresh\n");
    writeFileSync(join(config, "token_expires_at"), "0\n");
    writeFileSync(
      join(config, "refresh_terminal"),
      `${createHash("sha256").update("dead-refresh").digest("hex")}\n`,
    );
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { getClient, isSessionEnded } = await import("./client.js");
    expect(isSessionEnded()).toBe(true);
    await expect(getClient().get("/api/cli/test")).rejects.toMatchObject({ status: 401 });
    // Neither a naked API request nor a doomed broker refresh is fired.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("serializes independent module instances against one real credential directory", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "generation-one\n");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let brokerCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        brokerCalls += 1;
        await gate;
        return jsonResponse({
          access_token: "winner-access",
          refresh_token: "generation-two",
          expires_in: 300,
        });
      }),
    );

    const processOne = await import("./client.js");
    vi.resetModules();
    const processTwo = await import("./client.js");
    // `force` intentionally rotates even though the caller did not consult
    // expiry metadata; status verification uses this exact path.
    const first = processOne.refreshToken({ force: true, quiet: true });
    await eventually(() => expect(brokerCalls).toBe(1));
    const second = processTwo.refreshToken({ force: true, quiet: true });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(brokerCalls).toBe(1);
    release();

    await expect(Promise.all([first, second])).resolves.toEqual(["winner-access", "winner-access"]);
    expect(brokerCalls).toBe(1);
    expect(readFileSync(join(config, "refresh_token"), "utf8").trim()).toBe("generation-two");
  });

  it("adopts a non-rotation winner's access token without a redundant broker call", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "generation-one\n");
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let brokerCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        brokerCalls += 1;
        await gate;
        // WorkOS declines to rotate: the SAME refresh generation comes back.
        return jsonResponse({
          access_token: "winner-access",
          refresh_token: "generation-one",
          expires_in: 300,
        });
      }),
    );

    const processOne = await import("./client.js");
    vi.resetModules();
    const processTwo = await import("./client.js");
    const first = processOne.refreshToken({ force: true, quiet: true });
    await eventually(() => expect(brokerCalls).toBe(1));
    const second = processTwo.refreshToken({ force: true, quiet: true });
    await new Promise((resolve) => setTimeout(resolve, 75));
    expect(brokerCalls).toBe(1);
    release();

    // The loser adopts the committed access token rather than firing a second
    // broker round-trip that only re-consumes the unchanged refresh generation.
    await expect(Promise.all([first, second])).resolves.toEqual(["winner-access", "winner-access"]);
    expect(brokerCalls).toBe(1);
    expect(readFileSync(join(config, "refresh_token"), "utf8").trim()).toBe("generation-one");
  });

  it("set-token and clear remove stale OAuth and terminal state under the lock", async () => {
    writeFileSync(join(config, "token"), "old-access\n");
    writeFileSync(join(config, "refresh_token"), "old-refresh\n");
    writeFileSync(join(config, "token_expires_at"), "0\n");
    writeFileSync(join(config, "refresh_terminal"), "stale\n");
    writeFileSync(join(config, "credential_family.json"), "stale\n");
    writeFileSync(join(config, "credential_metadata.json"), "stale\n");
    writeFileSync(join(config, "credential_migration.json"), "stale\n");
    const client = await import("./client.js");

    const setStart = credentialStoreOperations.length;
    await client.setStoredToken("fixed-access");
    const refreshRemoval = credentialStoreOperations.indexOf(
      `remove:${client.REFRESH_TOKEN_PATH}`,
      setStart,
    );
    const sentinelRemoval = credentialStoreOperations.indexOf(
      `remove:${client.CREDENTIAL_MIGRATION_PATH}`,
      setStart,
    );
    const fixedTokenWrite = credentialStoreOperations.indexOf(
      `write:${client.TOKEN_FILE_PATH}`,
      setStart,
    );
    expect(refreshRemoval).toBeGreaterThanOrEqual(setStart);
    expect(sentinelRemoval).toBeGreaterThan(refreshRemoval);
    expect(fixedTokenWrite).toBeGreaterThan(sentinelRemoval);
    expect(client.resolveAuthCredential()).toEqual({
      token: "fixed-access",
      source: "token_file",
    });
    expect(readdirSync(config).sort()).toEqual(["token"]);

    let observed: string | undefined = "not-called";
    const removed = await client.clearStoredCredentials({
      beforeClear: (refresh) => {
        observed = refresh;
      },
    });
    expect(removed).toBe(true);
    expect(observed).toBeUndefined();
    expect(readdirSync(config)).toEqual([]);
  });

  it("migrates a pre-sentinel legacy JWT before clear's broker callback", async () => {
    writeFileSync(join(config, "token"), `${jwt({ aud: "client_cli" })}\n`);
    writeFileSync(join(config, "refresh_token"), "legacy-refresh\n");
    const client = await import("./client.js");
    let observed: unknown;

    const removed = await client.clearStoredCredentials({
      beforeClear: (_refreshToken, metadata) => {
        observed = metadata;
        expect(JSON.parse(readFileSync(client.CREDENTIAL_MIGRATION_PATH, "utf8"))).toEqual({
          version: 1,
          state: "family_bound",
        });
        expect(JSON.parse(readFileSync(client.CREDENTIAL_FAMILY_PATH, "utf8"))).toMatchObject({
          family: "legacy_broker",
        });
      },
    });

    expect(removed).toBe(true);
    expect(observed).toMatchObject({
      state: "legacy_broker",
      metadata: { family: "legacy_broker" },
    });
    expect(readdirSync(config)).toEqual([]);
  });

  it("preserves the install identity across OAuth rotation, set-token, and clear", async () => {
    const identity = await import("./daemon/client-instance-id.js");
    const client = await import("./client.js");
    const initial = await identity.getOrCreateClientInstanceId({
      configDir: config,
    });

    await client.commitCredentials({
      accessToken: "oauth-access",
      refreshToken: "oauth-refresh",
      expiresIn: 300,
    });
    await client.setStoredToken("fixed-access");
    await client.clearStoredCredentials();

    await expect(identity.getOrCreateClientInstanceId({ configDir: config })).resolves.toBe(
      initial,
    );
    expect(readdirSync(config)).toEqual(["client_instance_id"]);
  });

  it("keeps login, set-token, and clear races in a coherent final generation", async () => {
    const client = await import("./client.js");
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = client.withCredentialLock(() => held);
    await eventually(() => expect(existsSync(client.CREDENTIAL_LOCK_PATH)).toBe(true));

    const operations = [
      client.commitCredentials({
        accessToken: "oauth-access",
        refreshToken: "oauth-refresh",
        expiresIn: 300,
      }),
      client.setStoredToken("fixed-access"),
      client.clearStoredCredentials(),
    ];
    release();
    await owner;
    await Promise.all(operations);

    const access = existsSync(client.TOKEN_FILE_PATH)
      ? readFileSync(client.TOKEN_FILE_PATH, "utf8").trim()
      : undefined;
    if (access === "oauth-access") {
      expect(readFileSync(client.REFRESH_TOKEN_PATH, "utf8").trim()).toBe("oauth-refresh");
      expect(existsSync(client.TOKEN_EXPIRES_PATH)).toBe(true);
    } else if (access === "fixed-access") {
      expect(existsSync(client.REFRESH_TOKEN_PATH)).toBe(false);
      expect(existsSync(client.TOKEN_EXPIRES_PATH)).toBe(false);
    } else {
      expect(access).toBeUndefined();
      expect(existsSync(client.REFRESH_TOKEN_PATH)).toBe(false);
      expect(existsSync(client.TOKEN_EXPIRES_PATH)).toBe(false);
    }
    expect(existsSync(client.TERMINAL_REFRESH_PATH)).toBe(false);
    expect(existsSync(client.CREDENTIAL_LOCK_PATH)).toBe(false);
  });
});
