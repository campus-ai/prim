import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { insideClaudeCode, isClaudeCloudSession } from "./cloud-env.js";
import { primConfigDirectory } from "./paths.js";

// Who prepared a VM is decided by who is running the command.
export { insideClaudeCode };

/**
 * Written by `prim setup --cloud --prepare` into the cloud environment's cached
 * image. Its presence is the environment owner's opt-in: every repository a
 * session in that environment opens is prim's to capture unless it says
 * otherwise, which is the cloud counterpart of a committed project install.
 * Removing prim's user-scope Claude install removes it too.
 */
const CLOUD_PREPARED_MARKER = "cloud-prepared";
const CLOUD_PREPARED_VERSION = "1";
/** Prepared by plain `prim setup` inside a session, not by the image. */
const SESSION_ORIGIN = "session";

export function cloudPreparedPath(env: NodeJS.ProcessEnv = process.env): string {
  return join(primConfigDirectory({ env }), CLOUD_PREPARED_MARKER);
}

export function markCloudPrepared(
  env: NodeJS.ProcessEnv = process.env,
  origin: "image" | "session" = "image",
): void {
  const directory = primConfigDirectory({ env });
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  writeFileSync(
    cloudPreparedPath(env),
    `${CLOUD_PREPARED_VERSION}${origin === "session" ? ` ${SESSION_ORIGIN}` : ""}\n`,
    { mode: 0o600 },
  );
}

/**
 * True when this VM was prepared from inside a running session. Claude Code
 * read its settings before that, and new sessions start from the environment's
 * image, so the hooks are not live until the setup script prepares the image.
 */
export function preparedInSession(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return readFileSync(cloudPreparedPath(env), "utf8").trim().split(/\s+/u)[1] === SESSION_ORIGIN;
  } catch {
    return false;
  }
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
