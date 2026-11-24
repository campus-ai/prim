/**
 * Claude Code cloud session facts with no dependencies, so the HTTP client
 * and the hooks can both consult them without import cycles.
 */
export function isClaudeCloudSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_REMOTE === "true";
}

/**
 * True in a process Claude Code itself started (a tool call or a hook), which
 * is where it sets CLAUDECODE. A cloud environment's setup script runs before
 * Claude Code launches, so it is never true there, whatever else the VM's
 * environment already carries.
 */
export function insideClaudeCode(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDECODE === "1";
}

export const CLOUD_CREDENTIALS_REMEDY =
  'set PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET in the cloud environment\'s variables; mint them on your own machine with `prim auth enroll --new-installation "Claude Code cloud" --print-env`';

/**
 * A session reads its environment when it is created, so a fix made in the
 * environment's settings reaches the next session, not this one.
 */
export const CLOUD_REJECTED_CREDENTIALS_REMEDY =
  'correct the credentials in the cloud environment\'s settings, or if the installation was revoked mint a replacement on your own machine with `prim auth enroll --new-installation "Claude Code cloud" --print-env`; then start a new cloud session';

/** `prim github connect` drives a browser sign-in, which a cloud VM cannot. */
export const CLOUD_GITHUB_CONNECT_REMEDY =
  "run `prim github connect` in a clone of it on your own machine, then start a new cloud session";

/**
 * Where a cloud session's unconnected state has several possible causes
 * (credentials, a blocked host, an unconnected repository), point at the one
 * command that names which.
 */
export function cloudSetupPointer(message: string, env: NodeJS.ProcessEnv = process.env): string {
  return isClaudeCloudSession(env)
    ? `${message.replace(/[.;\s]+$/u, "")}; in this Claude Code cloud session, run \`prim setup --cloud\` for the fix`
    : message;
}
