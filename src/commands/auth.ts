/**
 * Auth commands for the prim CLI.
 *
 * prim auth login             — Open browser to authenticate via WorkOS
 * prim auth set-token <token> — Save a bearer token for authenticated calls
 * prim auth clear             — Remove the saved token
 */

import { exec } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform } from "node:os";
import { dirname } from "node:path";
import type { Command } from "commander";
import {
  REFRESH_TOKEN_PATH,
  TOKEN_EXPIRES_PATH,
  TOKEN_FILE_PATH,
  getAuthToken,
  getSiteUrl,
  getTokenExpiresAt,
  saveTokenExpiry,
} from "../client.js";
import { stripControlChars } from "../lib/ansi.js";
import { printJson } from "../output.js";

const FILE_MODE = 0o600;
const LOCALHOST = "127.0.0.1";
const CALLBACK_PORT = 19_876;
const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;
const SUCCESS_HTML = "<h1>Authentication successful!</h1><p>You can close this tab.</p>";
const FAILURE_HTML = "<h1>Authentication failed.</h1><p>Return to your terminal for details.</p>";
const STATE_MISMATCH_HTML = "<h1>State mismatch. Authentication failed.</h1>";
const BASE64_PLUS_RE = /\+/g;
const BASE64_SLASH_RE = /\//g;
const BASE64_PAD_RE = /=+$/;

function base64url(buffer: Buffer): string {
  return buffer
    .toString("base64")
    .replace(BASE64_PLUS_RE, "-")
    .replace(BASE64_SLASH_RE, "_")
    .replace(BASE64_PAD_RE, "");
}

function generatePkce(): { verifier: string; challenge: string } {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function openBrowser(url: string): void {
  const os = platform();
  const cmd = os === "darwin" ? "open" : os === "win32" ? "start" : "xdg-open";

  exec(`${cmd} "${url}"`);
}

function saveToken(token: string): void {
  const dir = dirname(TOKEN_FILE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(TOKEN_FILE_PATH, token, { mode: FILE_MODE });
}

export type CallbackResult =
  | { authenticated: true; code: string }
  | { authenticated: false; error: string; detail?: string };

export type CallbackPage = { status: number; html: string; result: CallbackResult };

/**
 * Map an OAuth callback request to the page to serve and the outcome to report.
 * Pure and total: `html` is always one of the module-local constants above, so
 * provider-supplied text can only ever travel through `result.error`/`detail`
 * (onto STDERR/STDOUT), never into the HTML. State is checked first so a
 * mismatched callback fails closed.
 */
export function resolveCallbackPage(params: URLSearchParams, expectedState: string): CallbackPage {
  if (params.get("state") !== expectedState) {
    return {
      status: 400,
      html: STATE_MISMATCH_HTML,
      result: {
        authenticated: false,
        error: "state_mismatch",
        detail: "state mismatch on the OAuth callback",
      },
    };
  }

  // RFC 6749 §4.1.2.1: a denial/error redirect carries the required `error`
  // code (e.g. access_denied) and an optional human `error_description`.
  const providerError = params.get("error");
  if (providerError) {
    return {
      status: 400,
      html: FAILURE_HTML,
      result: {
        authenticated: false,
        error: providerError,
        detail: params.get("error_description") ?? undefined,
      },
    };
  }

  const code = params.get("code");
  if (!code) {
    return {
      status: 400,
      html: FAILURE_HTML,
      result: {
        authenticated: false,
        error: "no_code",
        detail: "No authorization code received",
      },
    };
  }

  return { status: 200, html: SUCCESS_HTML, result: { authenticated: true, code } };
}

/**
 * The single terminal-failure emitter. Human verdict on STDERR with the
 * untrusted error/detail control-stripped so nothing smuggles escape sequences
 * into the terminal; machine-readable result on STDOUT (JSON.stringify renders
 * any residual control byte inert). Sets the exit code once and returns — the
 * event loop drains and the process exits on its own.
 */
function reportFailure(error: string, detail?: string): void {
  const human = detail
    ? `${stripControlChars(error)}: ${stripControlChars(detail)}`
    : stripControlChars(error);
  console.error(`Authentication failed: ${human}`);
  console.log(JSON.stringify({ authenticated: false, error, detail }));
  process.exitCode = EXIT_FAIL;
}

function reportSuccess(): void {
  console.error(`Authenticated! Token saved to ${TOKEN_FILE_PATH}`);
  console.log(JSON.stringify({ authenticated: true, tokenFile: TOKEN_FILE_PATH }));
  process.exitCode = EXIT_OK;
}

export function registerAuthCommands(program: Command) {
  const auth = program.command("auth").description("Manage CLI authentication");

  auth
    .command("login")
    .description("Authenticate via browser (WorkOS OAuth)")
    .action(async () => {
      const siteUrl = getSiteUrl();

      // Fetch broker config
      let config: {
        authorization_server: string;
        authorization_endpoint?: string;
        client_id: string;
        default_scopes: string[];
      };
      try {
        const res = await fetch(`${siteUrl}/mcp/config`);
        config = (await res.json()) as typeof config;
      } catch {
        reportFailure(
          "config_fetch_failed",
          "Failed to fetch MCP config. Is the Convex backend running?",
        );
        return;
      }

      if (!config.authorization_server || !config.client_id) {
        reportFailure("broker_not_configured", "MCP broker is not configured on the server.");
        return;
      }

      const { verifier, challenge } = generatePkce();
      const state = base64url(randomBytes(16));
      const redirectUri = `http://${LOCALHOST}:${CALLBACK_PORT}/callback`;

      // The handler is the only code that writes a callback response or knows
      // about HTML, and it never exits the process: it resolves an outcome from
      // res.end's flush callback (so the page is always on the wire first) that
      // the single exit point below turns into one exit.
      let settle!: (result: CallbackResult) => void;
      const outcome = new Promise<CallbackResult>((resolve) => {
        settle = resolve;
      });

      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${LOCALHOST}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }
        const page = resolveCallbackPage(url.searchParams, state);
        res.writeHead(page.status, HTML_HEADERS);
        res.end(page.html, () => settle(page.result));
      });

      // Bind the fixed callback port. Without an error handler a stale or
      // parallel login holding the port would hang forever, since the timeout
      // is only armed after a successful bind.
      try {
        await new Promise<void>((resolve, reject) => {
          const onError = (err: NodeJS.ErrnoException) => reject(err);
          server.once("error", onError);
          server.listen(CALLBACK_PORT, LOCALHOST, () => {
            server.removeListener("error", onError);
            resolve();
          });
        });
      } catch (err) {
        if (err instanceof Error && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
          reportFailure(
            "callback_port_in_use",
            `Port ${CALLBACK_PORT} is in use — another 'prim auth login' may be running. Close it and retry.`,
          );
        } else {
          reportFailure(
            "callback_bind_failed",
            `Could not start the local callback server: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        return;
      }

      // A post-bind server error would otherwise be an unhandled emitter error
      // that crashes the process; the timeout still bounds the wait.
      server.on("error", () => {
        // Swallow late socket errors — the outcome/timeout still resolves.
      });

      const authorizeUrl =
        config.authorization_endpoint ?? "https://api.workos.com/user_management/authorize";
      const authUrl = new URL(authorizeUrl);
      authUrl.searchParams.set("client_id", config.client_id);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("provider", "authkit");
      authUrl.searchParams.set("scope", config.default_scopes.join(" "));
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      // Guidance is for the human at the browser, so it rides STDERR — STDOUT
      // stays reserved for the machine-readable result line emitted on success.
      console.error("Opening browser for authentication...");
      openBrowser(authUrl.toString());
      console.error(`If the browser doesn't open, visit:\n${authUrl.toString()}\n`);
      console.error("Waiting for callback...");

      // Timeout resolves the same outcome as a callback, so every path funnels
      // through the single exit below. unref'd so the timer never keeps the
      // process alive — the listening server does, and closing it lets us exit.
      const timer = setTimeout(() => {
        settle({ authenticated: false, error: "timeout", detail: "Authentication timed out." });
      }, CALLBACK_TIMEOUT_MS);
      timer.unref();

      const result = await outcome;
      clearTimeout(timer);
      server.close();

      if (!result.authenticated) {
        reportFailure(result.error, result.detail);
        return;
      }

      // The success page is already flushed; exchange the code here so the exit
      // decision lives in exactly one place.
      try {
        const token = await exchangeCode(siteUrl, result.code, verifier, redirectUri);
        saveToken(token);
        reportSuccess();
      } catch (err) {
        reportFailure("token_exchange_failed", err instanceof Error ? err.message : String(err));
      }
    });

  auth
    .command("set-token <token>")
    .description("Save a bearer token for authenticated CLI calls")
    .action((token: string) => {
      saveToken(token);
      console.log(`Token saved to ${TOKEN_FILE_PATH}`);
    });

  auth
    .command("clear")
    .description("Remove the saved authentication token")
    .action(async () => {
      // Revoke refresh token server-side before deleting local files
      if (existsSync(REFRESH_TOKEN_PATH)) {
        const refreshTokenValue = readFileSync(REFRESH_TOKEN_PATH, "utf-8").trim();
        if (refreshTokenValue) {
          try {
            const siteUrl = getSiteUrl();
            const res = await fetch(`${siteUrl}/mcp/broker/revoke`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refresh_token: refreshTokenValue }),
            });
            if (res.ok) {
              console.log("Server token revoked.");
            } else {
              console.warn(
                "Server revocation failed (status %d) — clearing local files anyway.",
                res.status,
              );
            }
          } catch {
            console.warn("Could not reach server for revocation — clearing local files anyway.");
          }
        }
      }

      let removed = false;
      for (const filePath of [TOKEN_FILE_PATH, REFRESH_TOKEN_PATH, TOKEN_EXPIRES_PATH]) {
        if (existsSync(filePath)) {
          rmSync(filePath);
          removed = true;
        }
      }

      if (removed) {
        console.log("Local tokens removed.");
      } else {
        console.log("No saved tokens found.");
      }
    });

  auth
    .command("status")
    .description("Check authentication status and token expiry")
    .option("--json", "Output as JSON")
    .action((opts: { json?: boolean }) => {
      const token = getAuthToken();

      if (opts.json) {
        const expiresAt = getTokenExpiresAt();
        const expiresInMs = expiresAt ? expiresAt - Date.now() : null;
        const refreshPresent = existsSync(REFRESH_TOKEN_PATH);
        printJson({
          authenticated: !!token,
          tokenFile: token ? TOKEN_FILE_PATH : null,
          accessTokenExpiresInMs: expiresInMs,
          accessTokenExpired: expiresInMs !== null && expiresInMs <= 0,
          refreshTokenPresent: refreshPresent,
          warnings: !token || refreshPresent ? [] : ["no refresh token"],
        });
        process.exit(token ? 0 : 1);
      }

      if (!token) {
        console.log("Not authenticated. Run `prim auth login` to authenticate.");
        process.exit(1);
      }

      console.log("Authenticated.");
      console.log(`Token file: ${TOKEN_FILE_PATH}`);

      const expiresAt = getTokenExpiresAt();
      if (expiresAt) {
        const remaining = expiresAt - Date.now();
        if (remaining <= 0) {
          console.log("Access token: expired");
        } else {
          const minutes = Math.floor(remaining / 60_000);
          const seconds = Math.floor((remaining % 60_000) / 1000);
          console.log(`Access token expires in: ${minutes}m ${seconds}s`);
        }
      } else {
        console.log("Access token expiry: unknown (no metadata)");
      }

      const hasRefresh = existsSync(REFRESH_TOKEN_PATH);
      console.log(`Refresh token: ${hasRefresh ? "present" : "missing"}`);

      if (!hasRefresh) {
        console.log(
          "Warning: No refresh token. Re-run `prim auth login` when access token expires.",
        );
      }
    });
}

/**
 * Exchange authorization code for tokens via the MCP broker.
 * Returns the access token.
 */
async function exchangeCode(
  siteUrl: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<string> {
  const response = await fetch(`${siteUrl}/mcp/broker/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: codeVerifier,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${body}`);
  }

  const data = (await response.json()) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
  };

  if (!data.access_token) {
    throw new Error("No access token in response");
  }

  // Store refresh token alongside access token for future rotation
  if (data.refresh_token) {
    const refreshPath = TOKEN_FILE_PATH.replace("/token", "/refresh_token");
    const dir = dirname(refreshPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
    writeFileSync(refreshPath, data.refresh_token, { mode: FILE_MODE });
  }

  saveTokenExpiry(data.access_token, data.expires_in);

  return data.access_token;
}
