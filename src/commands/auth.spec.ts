import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../client.js", async () => {
  const actual = await vi.importActual<typeof import("../client.js")>("../client.js");
  return {
    ...actual,
    getAuthToken: vi.fn(),
    getTokenExpiresAt: vi.fn(),
    getSiteUrl: vi.fn(() => "http://127.0.0.1:9"),
  };
});

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return { ...actual, existsSync: vi.fn(() => false) };
});

// Login opens a browser via exec — never do that from a test run.
vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return { ...actual, exec: vi.fn() };
});

import { existsSync } from "node:fs";
import { get as httpGet } from "node:http";
import { getAuthToken, getTokenExpiresAt } from "../client.js";
import { registerAuthCommands, resolveCallbackPage } from "./auth.js";

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
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("emits a shaped JSON object and exits 0 when authenticated", async () => {
    vi.mocked(getAuthToken).mockReturnValue("tok");
    vi.mocked(getTokenExpiresAt).mockReturnValue(Date.now() + 60_000);
    vi.mocked(existsSync).mockReturnValue(true);
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
    expect(out.refreshTokenPresent).toBe(true);
    expect(out.accessTokenExpired).toBe(false);
    expect(typeof out.accessTokenExpiresInMs).toBe("number");
    expect(out.warnings).toEqual([]);
    expect(exitSpy).toHaveBeenCalledWith(0);
  });

  it("emits {authenticated: false} and exits 1 when unauthenticated", async () => {
    vi.mocked(getAuthToken).mockReturnValue(undefined);
    vi.mocked(getTokenExpiresAt).mockReturnValue(undefined);
    vi.mocked(existsSync).mockReturnValue(false);
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
    expect(out.tokenFile).toBeNull();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});
