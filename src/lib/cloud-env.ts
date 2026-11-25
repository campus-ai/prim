/**
 * Claude Code cloud session facts with no dependencies, so the HTTP client
 * and the hooks can both consult them without import cycles.
 */
export function isClaudeCloudSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_REMOTE === "true";
}

/**
 * True where prim sends every request to Primitive through the environment's
 * proxy: a cloud session whose credentials come from its variables, with a
 * proxy configured. A cloud VM's direct connections resolve only the hosts
 * that were under Allowed domains when the session was created; the proxy
 * follows that list as it is edited. Node uses the proxy only when told to at
 * startup, so prim routes the one process it starts itself, the token broker
 * (see brokerEnvironment), and hands that broker its requests.
 */
export function cloudProxyRouting(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isClaudeCloudSession(env) &&
    // As Node reads them, so prim and the broker's own runtime cannot disagree.
    Boolean(env.https_proxy ?? env.HTTPS_PROXY) &&
    (env.PRIM_M2M_CLIENT_ID !== undefined ||
      env.PRIM_M2M_CLIENT_SECRET !== undefined ||
      env.PRIM_M2M_CLIENT_AUTH !== undefined)
  );
}

/**
 * What follows "add … to Allowed domains" where prim's requests ride the
 * proxy: the edit reaches the running session. Elsewhere prim connects
 * directly, and the message is left as it was.
 */
export function cloudDomainEditNote(env: NodeJS.ProcessEnv = process.env): string {
  return cloudProxyRouting(env)
    ? "; the change takes effect in this session within about a minute"
    : "";
}

/**
 * The environment's proxy failed by itself: it answered a CONNECT with a
 * failure of its own, hung up, or could not be reached. Said in place of the
 * allowlist advice, which would send the user to add domains they have
 * already allowed.
 */
export const CLOUD_PROXY_FAILING =
  "The cloud environment's proxy is failing (not the Allowed domains list); retry shortly.";

/**
 * The proxy said nothing in time. It has not said whether it would open the
 * connection, so this neither blames the allowlist nor clears it.
 */
export const CLOUD_PROXY_SILENT =
  "The cloud environment's proxy did not answer in time; retry shortly.";

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
  'give the cloud environment PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET, as variables or with the secret held as a network secret; mint them on your own machine with `prim auth enroll --new-installation "Claude Code cloud" --print-env`, which says where each value goes';

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
    ? `${message.replace(/[.;\s]+$/u, "")}${CLOUD_SETUP_POINTER}`
    : message;
}

/** Cloud setup removes this from a message it relays: it is that command. */
export const CLOUD_SETUP_POINTER =
  "; in this Claude Code cloud session, run `prim setup --cloud` for the fix";
