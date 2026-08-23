/**
 * Decision Event Pipeline — session + org binding.
 *
 * Resolves the owning organization of a captured move via a priority chain:
 *
 *   1. Explicit session marker — <prim-config>/sessions/<sessionId>.json
 *      written by `prim session start`.
 *   2. Workspace pin — .prim/workspace.json, walking up from cwd.
 *   3. Default org — the org_id claim in the auth token's JWT. Covers the
 *      common single-org case with no local config.
 *   4. Unbound — undefined; the move journals to _unbound/ and
 *      `prim moves bind` can retroactively attribute it.
 *
 * Everything here is pure file IO + JWT base64 decoding. No network or HTTP
 * client imports — safe to call from prim-hook on the per-tool-call cold path.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { jwtOrganizationId, resolveAuthCredential } from "./lib/credentials.js";
import { primConfigDirectory } from "./lib/paths.js";

const PRIM_CONFIG_DIR = primConfigDirectory();
export const SESSIONS_DIR = join(PRIM_CONFIG_DIR, "sessions");
const WORKSPACE_FILE = ".prim/workspace.json";

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

export function fromDefaultOrg(_cwd: string): string | undefined {
  const credential = resolveAuthCredential();
  return credential ? jwtOrganizationId(credential.token) : undefined;
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
