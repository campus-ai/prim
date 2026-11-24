import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isClaudeCloudSession } from "./cloud-env.js";
import { primConfigDirectory } from "./paths.js";

/**
 * Written by `prim setup --cloud --prepare` into the cloud environment's cached
 * image. Its presence is the environment owner's opt-in: every repository a
 * session in that environment opens is prim's to capture unless it says
 * otherwise, which is the cloud counterpart of a committed project install.
 * Removing prim's user-scope Claude install removes it too.
 */
const CLOUD_PREPARED_MARKER = "cloud-prepared";
const CLOUD_PREPARED_VERSION = "1";

export function cloudPreparedPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(primConfigDirectory({ env }), CLOUD_PREPARED_MARKER);
}

export function markCloudPrepared(env: NodeJS.ProcessEnv = process.env): void {
  const directory = primConfigDirectory({ env });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(cloudPreparedPath(env), `${CLOUD_PREPARED_VERSION}\n`, { mode: 0o600 });
}

export function clearCloudPrepared(env: NodeJS.ProcessEnv = process.env): void {
  rmSync(cloudPreparedPath(env), { force: true });
}

/** True only inside a Claude Code cloud session whose environment ran `--prepare`. */
export function isPreparedCloudSession(env: NodeJS.ProcessEnv = process.env): boolean {
  if (!isClaudeCloudSession(env)) return false;
  try {
    return existsSync(cloudPreparedPath(env));
  } catch {
    return false;
  }
}
