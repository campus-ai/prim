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
      actual.renameSync(source, destination);
    },
  };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

  it("returns undefined when no expiry metadata exists", async () => {
    const { getTokenExpiresAt } = await import("./client.js");
    expect(getTokenExpiresAt()).toBeUndefined();
  });

  it("commits refresh, expiry, then access as mode-0600 files without temp residue", async () => {
    const { TOKEN_EXPIRES_PATH, TOKEN_FILE_PATH, REFRESH_TOKEN_PATH, commitCredentials } =
      await import("./client.js");
    await commitCredentials({
      accessToken: "new-access",
      refreshToken: "new-refresh",
      expiresIn: 120,
    });

    expect(readFileSync(REFRESH_TOKEN_PATH, "utf8").trim()).toBe("new-refresh");
    expect(readFileSync(TOKEN_FILE_PATH, "utf8").trim()).toBe("new-access");
    expect(Number(readFileSync(TOKEN_EXPIRES_PATH, "utf8"))).toBeGreaterThan(Date.now());
    for (const path of [REFRESH_TOKEN_PATH, TOKEN_FILE_PATH, TOKEN_EXPIRES_PATH]) {
      expect(statSync(path).mode & 0o777).toBe(0o600);
    }
    expect(renamedCredentialPaths).toEqual([
      REFRESH_TOKEN_PATH,
      TOKEN_EXPIRES_PATH,
      TOKEN_FILE_PATH,
    ]);
    expect(readdirSync(config).some((name) => name.includes(".tmp-"))).toBe(false);
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
  });

  it("does not mark a newer disk generation terminal after a legacy 401 loser", async () => {
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
    // Simulate an old, uncoordinated login client replacing the files directly.
    writeFileSync(client.REFRESH_TOKEN_PATH, "winner-refresh\n");
    writeFileSync(client.TOKEN_FILE_PATH, "winner-access\n");
    reject();

    await expect(refreshing).resolves.toBe("winner-access");
    expect(client.isSessionEnded()).toBe(false);
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
    const client = await import("./client.js");

    await client.setStoredToken("fixed-access");
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
