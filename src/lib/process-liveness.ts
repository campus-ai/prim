export type ProcessLivenessProbe = (pid: number, signal: 0) => unknown;

/**
 * Return whether a positive integer PID still names a process.
 *
 * `kill(pid, 0)` performs no signal delivery. EPERM still proves the process
 * exists; every other failure means the caller must treat the PID as dead.
 */
export function processIsAlive(pid: number, probe: ProcessLivenessProbe = process.kill): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    probe(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
