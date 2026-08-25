/**
 * Decision Event Pipeline — session + org binding.
 *
 * Resolves the owning organization of a captured move via a priority chain:
 *
 *   1. Explicit session marker — ~/.config/prim/sessions/<sessionId>.json
 *      written by `prim session start`.
 *   2. Workspace pin — .prim/workspace.json, walking up from cwd.
 *   3. Default org — the org_id claim in the auth token's JWT. Covers the
 *      common single-org case with no local config.
 *   4. Unbound — undefined; the move journals to _unbound/ and
 *      `prim moves bind` can retroactively attribute it.
 *
 * Everything here is pure file IO + JWT base64 decoding. No network, no
 * client/auth imports — safe to call from prim-hook on the per-tool-call
 * cold path.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PRIM_CONFIG_DIR = join(homedir(), ".config", "prim");
const TOKEN_PATH = join(PRIM_CONFIG_DIR, "token");
export const SESSIONS_DIR = join(PRIM_CONFIG_DIR, "sessions");
const WORKSPACE_FILE = ".prim/workspace.json";

const JWT_PARTS = 3;
const BASE64_PAD_4 = 4;
const ENV_TOKEN_LINE = /^\s*PRIM_TOKEN\s*=\s*(.*)$/m;
const SURROUNDING_QUOTES = /^["']|["']$/g;
const BASE64URL_MINUS = /-/g;
const BASE64URL_UNDERSCORE = /_/g;

type SessionMarker = { orgId?: string };
type WorkspaceConfig = { orgId?: string };

function readJsonSafe<T>(path: string): T | undefined {
  if (!existsSync(path)) {
    return;
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as T;
  } catch {
    return;
  }
}

export function fromSessionMarker(sessionId: string): string | undefined {
  if (!sessionId) {
    return;
  }
  const marker = readJsonSafe<SessionMarker>(join(SESSIONS_DIR, `${sessionId}.json`));
  return marker?.orgId;
}

export function fromWorkspaceFile(startDir: string): string | undefined {
  let dir = startDir;
  while (true) {
    const config = readJsonSafe<WorkspaceConfig>(join(dir, WORKSPACE_FILE));
    if (config?.orgId) {
      return config.orgId;
    }
    const parent = dirname(dir);
    if (parent === dir) {
      return;
    }
    dir = parent;
  }
}

/**
 * Resolve the bearer token the same way the HTTP client does — PRIM_TOKEN
 * env first (the preferred headless/CI path), then the token file, then a
 * PRIM_TOKEN line in the cwd's .env.local — without importing the client
 * (which would pull the auth/HTTP graph onto the hook cold path).
 */
function readToken(cwd: string): string | undefined {
  const fromEnv = process.env.PRIM_TOKEN;
  if (fromEnv) {
    return fromEnv.trim();
  }
  if (existsSync(TOKEN_PATH)) {
    return readFileSync(TOKEN_PATH, "utf-8").trim();
  }
  const envLocal = join(cwd, ".env.local");
  if (existsSync(envLocal)) {
    const match = readFileSync(envLocal, "utf-8").match(ENV_TOKEN_LINE);
    if (match) {
      return match[1].trim().replace(SURROUNDING_QUOTES, "");
    }
  }
  return;
}

function base64UrlDecode(s: string): string {
  const padded = s.padEnd(
    s.length + ((BASE64_PAD_4 - (s.length % BASE64_PAD_4)) % BASE64_PAD_4),
    "=",
  );
  const normalized = padded.replace(BASE64URL_MINUS, "+").replace(BASE64URL_UNDERSCORE, "/");
  return Buffer.from(normalized, "base64").toString("utf-8");
}

export function fromDefaultOrg(cwd: string): string | undefined {
  const token = readToken(cwd);
  if (!token) {
    return;
  }
  const parts = token.split(".");
  if (parts.length !== JWT_PARTS) {
    return;
  }
  try {
    const claims = JSON.parse(base64UrlDecode(parts[1])) as { org_id?: string };
    return claims.org_id;
  } catch {
    return;
  }
}

export type ResolvedBinding = {
  orgId: string | undefined;
  source: "session" | "workspace" | "defaultOrg" | "unbound";
};

export function resolveOrg(args: { sessionId: string; cwd: string }): ResolvedBinding {
  const fromSession = fromSessionMarker(args.sessionId);
  if (fromSession) {
    return { orgId: fromSession, source: "session" };
  }
  const fromWorkspace = fromWorkspaceFile(args.cwd);
  if (fromWorkspace) {
    return { orgId: fromWorkspace, source: "workspace" };
  }
  const fromDefault = fromDefaultOrg(args.cwd);
  if (fromDefault) {
    return { orgId: fromDefault, source: "defaultOrg" };
  }
  return { orgId: undefined, source: "unbound" };
}
