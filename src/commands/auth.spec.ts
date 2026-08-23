import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", async () => {
  const actual = await vi.importActual<typeof import("../client.js")>("../client.js");
  return {
    ...actual,
    resolveAuthCredential: vi.fn(),
    refreshToken: vi.fn(),
    isSessionEnded: vi.fn(() => false),
    commitCredentials: vi.fn(),
    setStoredToken: vi.fn(),
    clearStoredCredentials: vi.fn(),
    getTokenExpiresAt: vi.fn(),
    getSiteUrl: vi.fn(() => "http://127.0.0.1:9"),
  };
});

vi.mock("../lib/workos-connect.js", async () => {
  const actual = await vi.importActual<typeof import("../lib/workos-connect.js")>(
    "../lib/workos-connect.js",
  );
  return {
    ...actual,
    discoverWorkosConnect: vi.fn(),
    requestWorkosDeviceAuthorization: vi.fn(),
    pollWorkosDeviceAuthorization: vi.fn(),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    existsSync: vi.fn(() => false),
    readFileSync: vi.fn(() => "refresh-token"),
  };
});

// Login opens a browser via execFile — never do that from a test run.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, execFile: vi.fn() };
});

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import {
  clearStoredCredentials,
  commitCredentials,
  getTokenExpiresAt,
  isSessionEnded,
  refreshToken,
  resolveAuthCredential,
  setStoredToken,
} from "../client.js";
import {
  discoverWorkosConnect,
  pollWorkosDeviceAuthorization,
  requestWorkosDeviceAuthorization,
} from "../lib/workos-connect.js";
import {
  fetchAuthBrokerConfig,
  openBrowser,
  parseAuthBrokerConfig,
  registerAuthCommands,
  resolveCallbackPage,
} from "./auth.js";

beforeEach(() => {
  vi.mocked(discoverWorkosConnect).mockResolvedValue({ state: "legacy_server" });
});

describe("auth discovery and browser launch", () => {
  const validConfig = {
    authorization_server: "https://auth.example.test",
    authorization_endpoint: "https://api.workos.com/user_management/authorize",
    client_id: "client_test",
    default_scopes: ["openid", "offline_access"],
  };

  afterEach(() => vi.clearAllMocks());

  it("accepts the WorkOS authorization endpoint and a same-origin local endpoint", () => {
    expect(parseAuthBrokerConfig(validConfig)).toMatchObject({
      ...validConfig,
      authorization_server: "https://auth.example.test/",
    });
    expect(
      parseAuthBrokerConfig({
        ...validConfig,
        authorization_server: "http://127.0.0.1:4000",
        authorization_endpoint: "http://127.0.0.1:4000/authorize",
      }).authorization_endpoint,
    ).toBe("http://127.0.0.1:4000/authorize");
  });

  it("rejects malicious or insecure discovery endpoints", () => {
    expect(() =>
      parseAuthBrokerConfig({
        ...validConfig,
        authorization_endpoint: "https://api.workos.com.attacker.test/authorize",
      }),
    ).toThrow("host is not trusted");
    expect(() =>
      parseAuthBrokerConfig({
        ...validConfig,
        authorization_endpoint: "http://api.workos.com/user_management/authorize",
      }),
    ).toThrow("must use HTTPS");
    expect(() => parseAuthBrokerConfig({ ...validConfig, default_scopes: "openid" })).toThrow(
      "string array",
    );
  });

  it("rejects a non-success discovery response before parsing it", async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(validConfig), { status: 503 }));
    await expect(
      fetchAuthBrokerConfig("https://api.example.test", fetchImpl as unknown as typeof fetch),
    ).rejects.toThrow("HTTP 503");
  });

  it("passes the authorization URL as an argv value rather than shell text", () => {
    const url = 'https://api.workos.com/authorize?state="; touch /tmp/pwned; #';
    openBrowser(url);

    const call = vi.mocked(execFile).mock.calls[0];
    expect(call?.[0]).not.toContain(url);
    expect(call?.[1]).toContain(url);
    expect(call?.[2]).toMatchObject({ windowsHide: true });
  });
});

describe("registerAuthCommands", () => {
  it("registers the auth command group", () => {
    const program = new Command();
    registerAuthCommands(program);

    const auth = program.commands.find((c) => c.name() === "auth");
    expect(auth).toBeDefined();
  });

  it("registers login, set-token, clear, and status subcommands", () => {
    const program = new Command();
    registerAuthCommands(program);

    const auth = program.commands.find((c) => c.name() === "auth");
    const subcommands = auth?.commands.map((c) => c.name()) ?? [];

    expect(subcommands).toContain("login");
    expect(subcommands).toContain("set-token");
    expect(subcommands).toContain("clear");
    expect(subcommands).toContain("status");
  });
});

describe("credential mutation commands", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("stores a fixed token through the synchronized credential API", async () => {
    vi.mocked(setStoredToken).mockResolvedValue();
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerAuthCommands(program);

    await program.parseAsync(["auth", "set-token", "fixed-token"], { from: "user" });

    expect(setStoredToken).toHaveBeenCalledOnce();
    expect(setStoredToken).toHaveBeenCalledWith("fixed-token");
  });

  it("uses device flow without a callback server and commits its frozen provider context", async () => {
    vi.mocked(discoverWorkosConnect).mockResolvedValue({
      state: "available",
      configuration: {
        issuer: "https://auth.example.test",
        clientId: "client_cli",
        scopes: ["openid", "offline_access"],
      },
    });
    vi.mocked(requestWorkosDeviceAuthorization).mockResolvedValue({
      deviceCode: "device-code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://auth.example.test/device",
      verificationUriComplete: "https://auth.example.test/device?user_code=ABCD-EFGH",
      expiresIn: 600,
      interval: 5,
    });
    vi.mocked(pollWorkosDeviceAuthorization).mockResolvedValue({
      accessToken: "connect-access",
      refreshToken: "connect-refresh",
      expiresIn: 300,
    });
    vi.mocked(commitCredentials).mockResolvedValue();
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerAuthCommands(program);

    await program.parseAsync(["auth", "login", "--no-browser"], { from: "user" });

    expect(execFile).not.toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join("\n")).toContain("ABCD-EFGH");
    expect(commitCredentials).toHaveBeenCalledWith({
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
  });

  it("revokes and deletes one coherent refresh generation under the clear lock", async () => {
    vi.mocked(clearStoredCredentials).mockImplementation(async (options) => {
      await options?.beforeClear?.("refresh-generation", { state: "legacy_broker" });
      return true;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerAuthCommands(program);

    await program.parseAsync(["auth", "clear"], { from: "user" });

    expect(clearStoredCredentials).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:9/mcp/broker/revoke",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ refresh_token: "refresh-generation" }),
      }),
    );
  });

  it("does not send a Connect refresh token to the legacy broker during clear", async () => {
    vi.mocked(clearStoredCredentials).mockImplementation(async (options) => {
      await options?.beforeClear?.("connect-refresh", {
        state: "workos_connect",
        metadata: {
          version: 1,
          family: "workos_connect",
          issuer: "https://auth.example.test",
          clientId: "client_cli",
          accessTokenHash: "b".repeat(64),
          refreshTokenHash: "a".repeat(64),
        },
      });
      return true;
    });
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.spyOn(console, "log").mockImplementation(() => {});
    const program = new Command();
    registerAuthCommands(program);

    await program.parseAsync(["auth", "clear"], { from: "user" });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("resolveCallbackPage", () => {
  const STATE = "expected-state";

  it("fails closed on a state mismatch before reading code or error", () => {
    const page = resolveCallbackPage(new URLSearchParams("state=wrong&code=abc"), STATE);

    expect(page.status).toBe(400);
    expect(page.html).toContain("State mismatch");
    expect(page.result).toEqual({
      authenticated: false,
      error: "state_mismatch",
      detail: "state mismatch on the OAuth callback",
    });
  });

  it("reports the RFC 6749 error code on a denial with no description", () => {
    // The headline bug: the old code read only error_description and reported
    // "No authorization code received" on a real access_denied.
    const page = resolveCallbackPage(
      new URLSearchParams(`state=${STATE}&error=access_denied`),
      STATE,
    );

    expect(page.result).toMatchObject({ authenticated: false, error: "access_denied" });
    expect((page.result as { detail?: string }).detail).toBeUndefined();
    expect(page.html).not.toContain("No authorization code");
  });

  it("carries error_description as detail when the provider supplies one", () => {
    const page = resolveCallbackPage(
      new URLSearchParams(`state=${STATE}&error=invalid_scope&error_description=bad+scope`),
      STATE,
    );

    expect(page.result).toMatchObject({
      authenticated: false,
      error: "invalid_scope",
      detail: "bad scope",
    });
  });

  it("reports no_code when neither a code nor an error is present", () => {
    const page = resolveCallbackPage(new URLSearchParams(`state=${STATE}`), STATE);

    expect(page.result).toMatchObject({ authenticated: false, error: "no_code" });
  });

  it("returns the static success page and the code on a valid callback", () => {
    const page = resolveCallbackPage(new URLSearchParams(`state=${STATE}&code=the-code`), STATE);

    expect(page.status).toBe(200);
    expect(page.html).toContain("successful");
    expect(page.result).toEqual({ authenticated: true, code: "the-code" });
  });

  it("never reflects provider text into the HTML — it travels only in detail", () => {
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    // OSC clipboard-write + CSI clear-screen + a script tag, all smuggled in.
    const payload = `${ESC}]52;c;cGF5${BEL}${ESC}[2J<script>alert(1)</script>`;
    const params = new URLSearchParams();
    params.set("state", STATE);
    params.set("error", "access_denied");
    params.set("error_description", payload);

    const page = resolveCallbackPage(params, STATE);

    expect(page.html).not.toContain("script");
    expect(page.html).not.toContain(ESC);
    // The untrusted text is carried out-of-band, only in detail.
    expect(page.result).toMatchObject({ authenticated: false, detail: payload });
  });
});

type CallbackResponse = { status: number; contentType: string; body: string };

function get(url: string): Promise<CallbackResponse> {
  return new Promise((resolve, reject) => {
    // agent: false — each request gets a fresh socket, so a pooled keep-alive
    // connection can't outlive the server it was opened against.
    httpGet(url, { agent: false }, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () =>
        resolve({
          status: res.statusCode ?? 0,
          contentType: String(res.headers["content-type"] ?? ""),
          body,
        }),
      );
    }).on("error", reject);
  });
}

describe("auth login callback", () => {
  // The login action sets process.exitCode instead of calling process.exit;
  // restore it so a failure-path test doesn't fail the whole vitest run.
  const ORIGINAL_EXIT_CODE = process.exitCode;

  afterEach(() => {
    process.exitCode = ORIGINAL_EXIT_CODE;
    vi.restoreAllMocks();
  });

  // Kick off `auth login` against a mocked broker config and wait until the
  // callback server is listening. The action now blocks on the callback, so we
  // must NOT await parseAsync before driving the request — the pending promise
  // comes back as `done`, awaited once the callback has been sent.
  async function startLogin() {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      Response.json({
        authorization_server: "https://auth.example.com",
        authorization_endpoint: "https://auth.example.com/authorize",
        client_id: "client_123",
        default_scopes: ["openid"],
      }),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});

    const program = new Command();
    registerAuthCommands(program);
    const done = program.parseAsync(["auth", "login"], { from: "user" });

    await vi.waitFor(() => {
      const printed = errorSpy.mock.calls.map((call) => String(call[0]));
      expect(printed.some((message) => message.includes("Waiting for callback"))).toBe(true);
    });

    const lineFeed = String.fromCharCode(10);
    const visitLine = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes("visit:"));
    const authUrl = new URL(visitLine?.split(lineFeed)[1] ?? "");
    const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
    const state = authUrl.searchParams.get("state") ?? "";
    return { done, redirectUri, state, errorSpy, logSpy };
  }

  it("serves the full state-mismatch page, then reports on stderr + stdout with exit 1", async () => {
    const { done, redirectUri, errorSpy, logSpy } = await startLogin();

    const res = await get(`${redirectUri}?state=not-the-state&code=abc`);
    await done;

    // The complete page arrives (res.on('end') fired) before the process settled
    // its exit code — the flush-before-exit invariant, now observable because the
    // action never calls process.exit and resolves only from res.end's callback.
    expect(res.status).toBe(400);
    expect(res.body).toContain("State mismatch. Authentication failed.");

    const stderr = errorSpy.mock.calls.map((call) => call.join(" ")).join(String.fromCharCode(10));
    expect(stderr).toContain("state mismatch");

    const resultLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes("authenticated"));
    expect(JSON.parse(resultLine ?? "{}")).toMatchObject({
      authenticated: false,
      error: "state_mismatch",
    });
    expect(process.exitCode).toBe(1);
  });

  it("reports a provider denial by its RFC error code and strips control bytes from stderr", async () => {
    const { done, redirectUri, state, errorSpy, logSpy } = await startLogin();

    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    // Smuggle an OSC clipboard-write, a CSI clear-screen, and a script tag
    // through the provider's error_description.
    const payload = `${ESC}]52;c;cGF5${BEL}${ESC}[2J<script>alert(1)</script>`;
    const res = await get(
      `${redirectUri}?state=${state}&error=access_denied&error_description=${encodeURIComponent(payload)}`,
    );
    await done;

    // Static page: no provider text, no escape bytes reflected into the browser.
    expect(res.status).toBe(400);
    expect(res.body).not.toContain("script");
    expect(res.body).not.toContain(ESC);

    // STDERR: the RFC error code is reported (the fix), control bytes stripped.
    const stderr = errorSpy.mock.calls.map((call) => call.join(" ")).join(String.fromCharCode(10));
    expect(stderr).toContain("access_denied");
    expect(stderr).not.toContain(ESC);
    expect(stderr).not.toContain(BEL);

    // STDOUT: machine-readable failure carrying the RFC error code.
    const resultLine = logSpy.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes("authenticated"));
    expect(JSON.parse(resultLine ?? "{}")).toMatchObject({
      authenticated: false,
      error: "access_denied",
    });
    expect(process.exitCode).toBe(1);
  });
});

describe("auth status --json", () => {
  beforeEach(() => {
    vi.mocked(resolveAuthCredential).mockReturnValue(undefined);
    vi.mocked(refreshToken).mockResolvedValue(undefined);
    vi.mocked(isSessionEnded).mockReturnValue(false);
    vi.mocked(getTokenExpiresAt).mockReturnValue(undefined);
    vi.mocked(existsSync).mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("force-rotates stored OAuth credentials, verifies once, and exits 0", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "token_file", token: "old" });
    vi.mocked(refreshToken).mockResolvedValue("fresh");
    vi.mocked(getTokenExpiresAt).mockReturnValue(Date.now() + 60_000);
    vi.mocked(existsSync).mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null) => {
        throw new Error(`exit:${code ?? 0}`);
      });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:0");

    const out = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(out.authenticated).toBe(true);
    expect(out.status).toBe("valid");
    expect(out.reason).toBe("verified");
    expect(out.refreshTokenPresent).toBe(true);
    expect(out.accessTokenExpired).toBe(false);
    expect(typeof out.accessTokenExpiresInMs).toBe("number");
    expect(out.warnings).toEqual([]);
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(refreshToken).toHaveBeenCalledWith(
      expect.objectContaining({ force: true, signal: expect.any(AbortSignal) }),
    );
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:9/api/cli/auth/status",
      expect.objectContaining({ headers: { Authorization: "Bearer fresh" } }),
    );
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("emits invalid/missing_credentials and exits 1 without probing", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue(undefined);
    vi.mocked(getTokenExpiresAt).mockReturnValue(undefined);
    vi.mocked(existsSync).mockReturnValue(false);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    const exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((code?: number | string | null) => {
        throw new Error(`exit:${code ?? 0}`);
      });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:1");

    const out = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(out.authenticated).toBe(false);
    expect(out.status).toBe("invalid");
    expect(out.reason).toBe("missing_credentials");
    expect(out.tokenFile).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("probes a fixed environment credential without touching disk OAuth state", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "environment", token: "fixed" });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:0");

    const out = JSON.parse(String(logSpy.mock.calls[0][0])) as Record<string, unknown>;
    expect(out).toMatchObject({
      authenticated: true,
      status: "valid",
      tokenFile: null,
      accessTokenExpiresInMs: null,
      refreshTokenPresent: false,
    });
    expect(refreshToken).not.toHaveBeenCalled();
  });

  it("reports a terminal forced refresh as invalid without running the bearer probe", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "token_file", token: "old" });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(refreshToken).mockResolvedValue(undefined);
    vi.mocked(isSessionEnded).mockReturnValue(true);
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:1");

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      authenticated: false,
      status: "invalid",
      reason: "refresh_rejected",
    });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("reports a rejected protected probe as invalid/access_rejected and exits 1", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "environment", token: "rejected" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:1");

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      authenticated: false,
      status: "invalid",
      reason: "access_rejected",
    });
  });

  it("reports transport failure as unreachable and exits 2", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "environment", token: "fixed" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new DOMException("The operation timed out", "TimeoutError"),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:2");

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      authenticated: false,
      status: "unreachable",
      reason: "verification_unavailable",
    });
  });

  it("reports a 5xx probe as unreachable rather than invalid credentials", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "environment", token: "fixed" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response('{"error":"temporarily unavailable"}', { status: 503 }),
    );
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:2");

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      authenticated: false,
      status: "unreachable",
      reason: "verification_unavailable",
    });
  });

  it("reports a probe outage after a successful forced rotation as unreachable", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "token_file", token: "old" });
    vi.mocked(existsSync).mockReturnValue(true);
    vi.mocked(refreshToken).mockResolvedValue("fresh");
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response('{"error":"temporarily unavailable"}', { status: 503 }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(
      program.parseAsync(["auth", "status", "--json"], { from: "user" }),
    ).rejects.toThrow("exit:2");

    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toMatchObject({
      authenticated: false,
      status: "unreachable",
      reason: "verification_unavailable",
    });
    expect(refreshToken).toHaveBeenCalledOnce();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://127.0.0.1:9/api/cli/auth/status",
      expect.objectContaining({ headers: { Authorization: "Bearer fresh" } }),
    );
  });

  it("renders actionable human output for invalid credentials", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue(undefined);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(program.parseAsync(["auth", "status"], { from: "user" })).rejects.toThrow(
      "exit:1",
    );

    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toBe(
      "No credentials were found. Run `prim auth login` to authenticate.",
    );
  });

  it("renders non-destructive human output when verification is unreachable", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "environment", token: "fixed" });
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(program.parseAsync(["auth", "status"], { from: "user" })).rejects.toThrow(
      "exit:2",
    );

    expect(logSpy.mock.calls.map((call) => String(call[0])).join("\n")).toBe(
      "Authentication could not be verified. Credentials were retained.",
    );
  });

  it("renders a concise verified verdict for fixed credentials", async () => {
    vi.mocked(resolveAuthCredential).mockReturnValue({ source: "environment", token: "fixed" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}"));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(process, "exit").mockImplementation((code?: number | string | null) => {
      throw new Error(`exit:${code ?? 0}`);
    });

    const program = new Command();
    registerAuthCommands(program);
    await expect(program.parseAsync(["auth", "status"], { from: "user" })).rejects.toThrow(
      "exit:0",
    );

    const human = logSpy.mock.calls.map((call) => String(call[0])).join("\n");
    expect(human).toContain("Authenticated (verified).");
    expect(human).toContain("Token source: fixed environment credential");
    expect(human).toContain("Refresh token: not applicable");
  });
});
