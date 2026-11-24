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
