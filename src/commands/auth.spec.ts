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
  it("fails closed on a state mismatch", () => {
    const page = resolveCallbackPage(new URLSearchParams("state=wrong&code=abc"), "expected");

    expect(page.status).toBe(400);
    expect(page.exitCode).toBe(1);
    expect(page.html).toContain("State mismatch");
  });

  it("keeps error_description out of the HTML and routes it to stderr", () => {
    const payload = "<img src=x onerror=alert(1)>";
    const params = new URLSearchParams(`state=s&error_description=${encodeURIComponent(payload)}`);

    const page = resolveCallbackPage(params, "s");

    expect(page.status).toBe(400);
    expect(page.exitCode).toBe(1);
    expect(page.html).not.toContain(payload);
    expect(page.stderr).toContain(payload);
  });

  it("serves the success page without scheduling an exit", () => {
    const page = resolveCallbackPage(new URLSearchParams("state=s&code=abc"), "s");

    expect(page.status).toBe(200);
    expect(page.exitCode).toBeUndefined();
    expect(page.stderr).toBeUndefined();
    expect(page.html).toContain("Authentication successful");
  });
});

describe("auth login callback", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Boot `auth login` against a mocked broker config and recover the callback
  // URL + state the command generated from its own stderr guidance.
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
    const exitSpy = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);

    const program = new Command();
    registerAuthCommands(program);
    await program.parseAsync(["auth", "login"], { from: "user" });

    const visitLine = errorSpy.mock.calls
      .map((call) => String(call[0]))
      .find((message) => message.includes("visit:"));
    const authUrl = new URL(visitLine?.split("\n")[1] ?? "");
    const redirectUri = authUrl.searchParams.get("redirect_uri") ?? "";
    const state = authUrl.searchParams.get("state") ?? "";
    return { redirectUri, state, errorSpy, exitSpy };
  }

  function get(url: string): Promise<{ status: number; contentType: string; body: string }> {
    return new Promise((resolve, reject) => {
      // agent: false — each request gets a fresh socket; the default keep-alive
      // agent would hand test 2 a pooled socket into test 1's closed server.
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

  it("keeps provider error_description out of the HTML and reports it on stderr", async () => {
    const { redirectUri, state, errorSpy, exitSpy } = await startLogin();

    // HTML in the payload probes reflection into the page; the ANSI prefix
    // probes escape-sequence smuggling into the terminal.
    const payload = '\u001b[31m<script>alert("pwned")</script>';
    const res = await get(
      `${redirectUri}?state=${state}&error_description=${encodeURIComponent(payload)}`,
    );

    expect(res.status).toBe(400);
    expect(res.contentType).toBe("text/html; charset=utf-8");
    expect(res.body).not.toContain("<script>");
    expect(res.body).toContain("Authentication failed");

    const stderr = errorSpy.mock.calls.map((call) => call.join(" ")).join("\n");
    expect(stderr).toContain('<script>alert("pwned")</script>');
    expect(stderr).not.toContain("\u001b");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
  });

  it("serves the complete state-mismatch page and requests exit 1", async () => {
    const { redirectUri, exitSpy } = await startLogin();

    const res = await get(`${redirectUri}?state=not-the-state&code=abc`);

    // End-to-end failure-path check: the full page arrives and exit(1) is
    // requested. (With process.exit mocked, the flush-before-exit ordering
    // itself isn't observable here — that invariant lives in the handler,
    // which only exits from res.end's callback.)
    expect(res.status).toBe(400);
    expect(res.contentType).toBe("text/html; charset=utf-8");
    expect(res.body).toContain("State mismatch. Authentication failed.");
    await vi.waitFor(() => expect(exitSpy).toHaveBeenCalledWith(1));
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
