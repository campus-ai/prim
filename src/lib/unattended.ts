/**
 * Marks a prim process that another prim process started in the background
 * (a hook-side `moves flush`, SessionStart's `daemon ensure`) rather than one a
 * person or their agent ran. Attended-only startup work, the daemon drift heal,
 * skips marked processes, and every descendant inherits the marker through
 * its environment. Every internal spawn of the `prim` entrypoint that nobody
 * waits on must set it.
 */
export const UNATTENDED_ENV = "PRIM_UNATTENDED";

/** The environment for an unattended child of this process. */
export function unattendedEnv(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, [UNATTENDED_ENV]: "1" };
}

export function isUnattended(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[UNATTENDED_ENV] === "1";
}
