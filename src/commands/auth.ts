/**
 * Auth commands for the prim CLI.
 *
 * prim auth login             — Open browser to authenticate via WorkOS
 * prim auth set-token <token> — Save a bearer token for authenticated calls
 * prim auth clear             — Remove the saved token
 * prim auth api-keys mint|list|revoke
 */

import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { platform } from "node:os";
import type { Command } from "commander";
import { listUserApiKeys, mintUserApiKey, revokeUserApiKey } from "../auth/api-keys.js";
import {
  REFRESH_TOKEN_PATH,
  TOKEN_FILE_PATH,
  clearStoredCredentials,
  commitCredentials,
  getSiteUrl,
  getTokenExpiresAt,
  isSessionEnded,
  refreshToken,
  resolveAuthCredential,
  setStoredToken,
} from "../client.js";
import { stripControlChars } from "../lib/terminal-safe.js";
import {
  WorkosConnectProtocolError,
  discoverWorkosConnect,
  pollWorkosDeviceAuthorization,
  requestWorkosDeviceAuthorization,
} from "../lib/workos-connect.js";
import { printJson } from "../output.js";
import { FAILURE_HTML, STATE_MISMATCH_HTML, SUCCESS_HTML } from "./auth-pages.js";

const LOCALHOST = "127.0.0.1";
const CALLBACK_PORT = 19_876;
const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes
const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_UNREACHABLE = 2;
const AUTH_PROBE_TIMEOUT_MS = 10_000;
const HTML_HEADERS = { "Content-Type": "text/html; charset=utf-8" } as const;
const BASE64_PLUS_RE = /\+/g;
const BASE64_SLASH_RE = /\//g;
const BASE64_PAD_RE = /=+$/;
const DEFAULT_WORKOS_AUTHORIZE_URL = "https://api.workos.com/user_management/authorize";

export interface AuthBrokerConfig {
  authorization_server: string;
  authorization_endpoint: string;
  client_id: string;
  default_scopes: string[];
}

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

export function openBrowser(url: string): void {
  const os = platform();
  const command = os === "darwin" ? "open" : os === "win32" ? "rundll32.exe" : "xdg-open";
  const args = os === "win32" ? ["url.dll,FileProtocolHandler", url] : [url];
  execFile(command, args, { windowsHide: true }, () => {});
}

function parseHttpUrl(value: string, field: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${field} must be an absolute URL`);
  }
  if (url.username || url.password) throw new Error(`${field} must not contain credentials`);
  const loopback =
    url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new Error(`${field} must use HTTPS`);
  }
  return url;
}

/** Validate the server's discovery document before opening an authorization URL. */
export function parseAuthBrokerConfig(value: unknown): AuthBrokerConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("broker config must be an object");
  }
  const record = value as Record<string, unknown>;
  if (typeof record.authorization_server !== "string" || !record.authorization_server.trim()) {
    throw new Error("authorization_server is required");
  }
  if (typeof record.client_id !== "string" || !record.client_id.trim()) {
    throw new Error("client_id is required");
  }
  if (
    !Array.isArray(record.default_scopes) ||
    !record.default_scopes.every((scope) => typeof scope === "string" && scope.length > 0)
  ) {
    throw new Error("default_scopes must be a string array");
  }

  const authorizationServer = parseHttpUrl(record.authorization_server, "authorization_server");
  const rawEndpoint =
    record.authorization_endpoint === undefined
      ? DEFAULT_WORKOS_AUTHORIZE_URL
      : record.authorization_endpoint;
  if (typeof rawEndpoint !== "string" || !rawEndpoint.trim()) {
    throw new Error("authorization_endpoint must be a URL");
  }
  const authorizationEndpoint = parseHttpUrl(rawEndpoint, "authorization_endpoint");
  if (
    authorizationEndpoint.origin !== "https://api.workos.com" &&
    authorizationEndpoint.origin !== authorizationServer.origin
  ) {
    throw new Error("authorization_endpoint host is not trusted");
  }

  return {
    authorization_server: authorizationServer.toString(),
    authorization_endpoint: authorizationEndpoint.toString(),
    client_id: record.client_id.trim(),
    default_scopes: [...record.default_scopes],
  };
}

export async function fetchAuthBrokerConfig(
  siteUrl: string,
  fetchImpl: typeof fetch = fetch,
): Promise<AuthBrokerConfig> {
  const response = await fetchImpl(`${siteUrl}/mcp/config`, {
    signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`broker discovery returned HTTP ${response.status}`);
  return parseAuthBrokerConfig(await response.json());
}

export type CallbackResult =
  | { authenticated: true; code: string }
  | { authenticated: false; error: string; detail?: string };

export type CallbackPage = { status: number; html: string; result: CallbackResult };

/**
 * Map an OAuth callback request to the page to serve and the outcome to report.
 * Pure and total: `html` is always one of the branded pages in ./auth-pages, so
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

export type AuthVerificationStatus = "valid" | "invalid" | "unreachable";
export type AuthVerificationReason =
  | "verified"
  | "missing_credentials"
  | "access_rejected"
  | "refresh_rejected"
  | "verification_unavailable";

export type AuthStatusResult = {
  authenticated: boolean;
  status: AuthVerificationStatus;
  reason: AuthVerificationReason;
  tokenFile: string | null;
  accessTokenExpiresInMs: number | null;
  accessTokenExpired: boolean;
  refreshTokenPresent: boolean;
  warnings: string[];
};

function hasStoredRefreshToken(): boolean {
  if (!existsSync(REFRESH_TOKEN_PATH)) return false;
  try {
    return readFileSync(REFRESH_TOKEN_PATH, "utf-8").trim().length > 0;
  } catch {
    return false;
  }
}

function authStatusResult(
  status: AuthVerificationStatus,
  reason: AuthVerificationReason,
  source: "environment" | "token_file" | undefined,
  refreshTokenPresent: boolean,
): AuthStatusResult {
  const expiresAt = source === "token_file" ? getTokenExpiresAt() : undefined;
  const expiresInMs = expiresAt === undefined ? null : expiresAt - Date.now();
  return {
    authenticated: status === "valid",
    status,
    reason,
    tokenFile: source === "token_file" ? TOKEN_FILE_PATH : null,
    accessTokenExpiresInMs: expiresInMs,
    accessTokenExpired: expiresInMs !== null && expiresInMs <= 0,
    refreshTokenPresent,
    warnings: source === "token_file" && !refreshTokenPresent ? ["no refresh token"] : [],
  };
}

/** Verify the selected credential without letting the protected probe rotate it again. */
export async function verifyAuthStatus(): Promise<AuthStatusResult> {
  const credential = resolveAuthCredential();
  if (!credential) {
    return authStatusResult("invalid", "missing_credentials", undefined, false);
  }

  const storedCredential = credential.source === "token_file";
  const refreshPresent = storedCredential && hasStoredRefreshToken();
  let accessToken = credential.token;

  if (refreshPresent) {
    try {
      const refreshed = await refreshToken({
        force: true,
        signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
      });
      if (!refreshed) {
        const rejected = isSessionEnded();
        return authStatusResult(
          rejected ? "invalid" : "unreachable",
          rejected ? "refresh_rejected" : "verification_unavailable",
          credential.source,
          true,
        );
      }
      accessToken = refreshed;
    } catch {
      const rejected = isSessionEnded();
      return authStatusResult(
        rejected ? "invalid" : "unreachable",
        rejected ? "refresh_rejected" : "verification_unavailable",
        credential.source,
        true,
      );
    }
  }

  try {
    const response = await fetch(`${getSiteUrl()}/api/cli/auth/status`, {
      method: "GET",
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
    });
    if (response.ok) {
      return authStatusResult("valid", "verified", credential.source, refreshPresent);
    }
    if (response.status === 401 || response.status === 403) {
      return authStatusResult("invalid", "access_rejected", credential.source, refreshPresent);
    }
    return authStatusResult(
      "unreachable",
      "verification_unavailable",
      credential.source,
      refreshPresent,
    );
  } catch {
    return authStatusResult(
      "unreachable",
      "verification_unavailable",
      credential.source,
      refreshPresent,
    );
  }
}

function authStatusExitCode(status: AuthVerificationStatus): number {
  if (status === "valid") return EXIT_OK;
  return status === "invalid" ? EXIT_FAIL : EXIT_UNREACHABLE;
}

function writeHumanAuthStatus(result: AuthStatusResult): void {
  if (result.status === "invalid") {
    const detail =
      result.reason === "refresh_rejected"
        ? "The saved session was rejected."
        : result.reason === "access_rejected"
          ? "The selected access token was rejected."
          : "No credentials were found.";
    console.log(`${detail} Run \`prim auth login\` to authenticate.`);
    return;
  }
  if (result.status === "unreachable") {
    console.log("Authentication could not be verified. Credentials were retained.");
    return;
  }

  console.log("Authenticated (verified).");
  if (result.tokenFile) {
    console.log(`Token file: ${result.tokenFile}`);
  } else {
    console.log("Token source: fixed environment credential");
  }
  if (result.accessTokenExpiresInMs === null) {
    console.log("Access token expiry: unknown (no metadata)");
  } else if (result.accessTokenExpiresInMs <= 0) {
    console.log("Access token: expired");
  } else {
    const minutes = Math.floor(result.accessTokenExpiresInMs / 60_000);
    const seconds = Math.floor((result.accessTokenExpiresInMs % 60_000) / 1000);
    console.log(`Access token expires in: ${minutes}m ${seconds}s`);
  }
  console.log(
    `Refresh token: ${result.tokenFile ? (result.refreshTokenPresent ? "present" : "missing") : "not applicable"}`,
  );
  for (const warning of result.warnings) console.log(`Warning: ${warning}`);
}

export function registerAuthCommands(program: Command) {
  const auth = program.command("auth").description("Manage CLI authentication");

  const apiKeys = auth
    .command("api-keys")
    .description("Mint, list, and revoke WorkOS user API keys");

  apiKeys
    .command("mint")
    .description("Mint a user API key and return its secret once")
    .requiredOption("--name <name>", "Name for the API key")
    .option("--expires-at <epoch-ms>", "Optional expiration as Unix epoch milliseconds")
    .action(async (options: { name: string; expiresAt?: string }) => {
      const expiresAt = options.expiresAt === undefined ? undefined : Number(options.expiresAt);
      process.exitCode = await mintUserApiKey({
        name: options.name,
        ...(expiresAt === undefined ? {} : { expiresAt }),
      });
    });

  apiKeys
    .command("list")
    .description("List user API-key metadata (never plaintext secrets)")
    .option("--limit <count>", "Maximum keys to return (1-100)", "100")
    .option("--after <api-key-id>", "Continue after this API-key ID")
    .action(async (options: { limit: string; after?: string }) => {
      process.exitCode = await listUserApiKeys({
        limit: Number(options.limit),
        ...(options.after === undefined ? {} : { after: options.after }),
      });
    });

  apiKeys
    .command("revoke <apiKeyId>")
    .description("Revoke one API key owned by the current user and organization")
    .action(async (apiKeyId: string) => {
      process.exitCode = await revokeUserApiKey(apiKeyId);
    });

  auth
    .command("login")
    .description("Authenticate via browser (WorkOS OAuth)")
    .option("--no-browser", "Print the verification URL without opening a browser")
    .action(async (options: { browser: boolean }) => {
      const siteUrl = getSiteUrl();

      let discovery: Awaited<ReturnType<typeof discoverWorkosConnect>>;
      try {
        discovery = await discoverWorkosConnect(siteUrl);
      } catch (error) {
        reportFailure(
          error instanceof WorkosConnectProtocolError ? error.code : "config_fetch_failed",
          error instanceof Error ? error.message : "Connect discovery failed",
        );
        return;
      }

      if (discovery.state === "available") {
        try {
          const authorization = await requestWorkosDeviceAuthorization(discovery.configuration);
          const verificationUrl =
            authorization.verificationUriComplete ?? authorization.verificationUri;
          console.error(`Authenticate at:\n${verificationUrl}`);
          console.error(`Verification code: ${authorization.userCode}`);
          if (options.browser) openBrowser(verificationUrl);
          const tokens = await pollWorkosDeviceAuthorization(
            discovery.configuration,
            authorization,
          );
          await commitCredentials({
            ...tokens,
            metadata: {
              version: 1,
              family: "workos_connect",
              issuer: discovery.configuration.issuer,
              clientId: discovery.configuration.clientId,
            },
          });
          reportSuccess();
        } catch (error) {
          reportFailure(
            error instanceof WorkosConnectProtocolError
              ? error.code
              : "device_authorization_failed",
            error instanceof Error ? error.message : "Device authorization failed",
          );
        }
        return;
      }

      let config: AuthBrokerConfig;
      try {
        config = await fetchAuthBrokerConfig(siteUrl);
      } catch {
        reportFailure(
          "config_fetch_failed",
          "Failed to fetch MCP config. Is the Convex backend running?",
        );
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

      const authUrl = new URL(config.authorization_endpoint);
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
      if (options.browser) {
        console.error("Opening browser for authentication...");
        openBrowser(authUrl.toString());
      }
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
        const tokens = await exchangeCode(siteUrl, result.code, verifier, redirectUri);
        await commitCredentials(tokens);
        reportSuccess();
      } catch (err) {
        reportFailure("token_exchange_failed", err instanceof Error ? err.message : String(err));
      }
    });

  auth
    .command("set-token <token>")
    .description("Save a bearer token for authenticated CLI calls")
    .action(async (token: string) => {
      await setStoredToken(token);
      console.log(`Token saved to ${TOKEN_FILE_PATH}`);
    });

  auth
    .command("clear")
    .description("Remove the saved authentication token")
    .action(async () => {
      const removed = await clearStoredCredentials({
        beforeClear: async (refreshTokenValue, metadata) => {
          if (!refreshTokenValue || metadata.state !== "legacy_broker") return;
          try {
            const siteUrl = getSiteUrl();
            const res = await fetch(`${siteUrl}/mcp/broker/revoke`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refresh_token: refreshTokenValue }),
              signal: AbortSignal.timeout(AUTH_PROBE_TIMEOUT_MS),
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
        },
      });

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
    .action(async (opts: { json?: boolean }) => {
      const result = await verifyAuthStatus();
      if (opts.json) printJson(result);
      else writeHumanAuthStatus(result);
      process.exit(authStatusExitCode(result.status));
    });
}

/**
 * Exchange authorization code for tokens via the MCP broker.
 * Returns the complete credential bundle; the caller commits it atomically.
 */
async function exchangeCode(
  siteUrl: string,
  code: string,
  codeVerifier: string,
  redirectUri: string,
): Promise<{ accessToken: string; refreshToken: string; expiresIn?: number }> {
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

  if (!data.access_token || !data.refresh_token) {
    throw new Error("Token exchange did not return a complete credential pair");
  }
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token,
    expiresIn: data.expires_in,
  };
}
