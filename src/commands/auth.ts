/**
 * Auth commands for the prim CLI.
 *
 * prim auth login             — Open browser to authenticate via WorkOS
 * prim auth set-token <token> — Save a bearer token for authenticated calls
 * prim auth clear             — Remove the saved token
 */

import { randomBytes, createHash } from "node:crypto";
import { exec } from "node:child_process";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { platform } from "node:os";
import type { Command } from "commander";
import { REFRESH_TOKEN_PATH, TOKEN_FILE_PATH, getConvexUrl } from "../client.js";

const FILE_MODE = 0o600;
const LOCALHOST = "127.0.0.1";
const CALLBACK_PORT = 19_876;
const CALLBACK_TIMEOUT_MS = 120_000; // 2 minutes
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
  const cmd =
    os === "darwin"
      ? "open"
      : os === "win32"
        ? "start"
        : "xdg-open";

  exec(`${cmd} "${url}"`);
}

function saveToken(token: string): void {
  const dir = dirname(TOKEN_FILE_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(TOKEN_FILE_PATH, token, { mode: FILE_MODE });
}

export function registerAuthCommands(program: Command) {
  const auth = program
    .command("auth")
    .description("Manage CLI authentication");

  auth
    .command("login")
    .description("Authenticate via browser (WorkOS OAuth)")
    .action(async () => {
      const convexUrl = getConvexUrl();
      const siteUrl = convexUrl
        .replace(".convex.cloud", ".convex.site");

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
        console.error(
          "Failed to fetch MCP config. Is the Convex backend running?"
        );
        process.exit(1);
      }

      if (!config.authorization_server || !config.client_id) {
        console.error("MCP broker is not configured on the server.");
        process.exit(1);
      }

      const { verifier, challenge } = generatePkce();
      const state = base64url(randomBytes(16));

      // Start local callback server on a random port
      const server = createServer((req, res) => {
        const url = new URL(req.url ?? "/", `http://${LOCALHOST}`);
        if (url.pathname !== "/callback") {
          res.writeHead(404);
          res.end("Not found");
          return;
        }

        const code = url.searchParams.get("code");
        const returnedState = url.searchParams.get("state");

        if (returnedState !== state) {
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end("<h1>State mismatch. Authentication failed.</h1>");
          server.close();
          process.exit(1);
        }

        if (!code) {
          const error = url.searchParams.get("error_description") ?? "No authorization code received";
          res.writeHead(400, { "Content-Type": "text/html" });
          res.end(`<h1>Authentication failed: ${error}</h1>`);
          server.close();
          process.exit(1);
        }

        res.writeHead(200, { "Content-Type": "text/html" });
        res.end(
          "<h1>Authentication successful!</h1><p>You can close this tab.</p>"
        );

        // Exchange code for tokens
        exchangeCode(siteUrl, code, verifier, `http://${LOCALHOST}:${port}/callback`)
          .then((token) => {
            saveToken(token);
            console.log(`Authenticated! Token saved to ${TOKEN_FILE_PATH}`);
            server.close();
            process.exit(0);
          })
          .catch((err) => {
            console.error("Token exchange failed:", err);
            server.close();
            process.exit(1);
          });
      });

      const port: number = await new Promise((resolve) => {
        server.listen(CALLBACK_PORT, LOCALHOST, () => {
          const addr = server.address();
          resolve(typeof addr === "object" && addr ? addr.port : 0);
        });
      });

      const redirectUri = `http://${LOCALHOST}:${port}/callback`;
      const authorizeUrl = config.authorization_endpoint
        ?? "https://api.workos.com/user_management/authorize";
      const authUrl = new URL(authorizeUrl);
      authUrl.searchParams.set("client_id", config.client_id);
      authUrl.searchParams.set("redirect_uri", redirectUri);
      authUrl.searchParams.set("response_type", "code");
      authUrl.searchParams.set("provider", "authkit");
      authUrl.searchParams.set(
        "scope",
        config.default_scopes.join(" ")
      );
      authUrl.searchParams.set("state", state);
      authUrl.searchParams.set("code_challenge", challenge);
      authUrl.searchParams.set("code_challenge_method", "S256");

      console.log("Opening browser for authentication...");
      openBrowser(authUrl.toString());
      console.log(
        `If the browser doesn't open, visit:\n${authUrl.toString()}\n`
      );
      console.log("Waiting for callback...");

      // Timeout
      setTimeout(() => {
        console.error("Authentication timed out.");
        server.close();
        process.exit(1);
      }, CALLBACK_TIMEOUT_MS);
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
            const siteUrl = getConvexUrl().replace(".convex.cloud", ".convex.site");
            const res = await fetch(`${siteUrl}/mcp/broker/revoke`, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ refresh_token: refreshTokenValue }),
            });
            if (res.ok) {
              console.log("Server token revoked.");
            } else {
              console.warn("Server revocation failed (status %d) — clearing local files anyway.", res.status);
            }
          } catch {
            console.warn("Could not reach server for revocation — clearing local files anyway.");
          }
        }
      }

      let removed = false;
      if (existsSync(TOKEN_FILE_PATH)) {
        rmSync(TOKEN_FILE_PATH);
        removed = true;
      }
      if (existsSync(REFRESH_TOKEN_PATH)) {
        rmSync(REFRESH_TOKEN_PATH);
        removed = true;
      }

      if (removed) {
        console.log("Local tokens removed.");
      } else {
        console.log("No saved tokens found.");
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
  redirectUri: string
): Promise<string> {
  const response = await fetch(`${siteUrl}/mcp/broker/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      code,
      // biome-ignore lint/style/useNamingConvention: OAuth field
      code_verifier: codeVerifier,
      // biome-ignore lint/style/useNamingConvention: OAuth field
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

  return data.access_token;
}
