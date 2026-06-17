/**
 * Daemon-first transport for the prim decision READS.
 *
 * Routes the idempotent, latency-sensitive decision reads (recent / show /
 * cascade / affecting) through the long-lived prim-daemon's warm connection
 * when it's up, falling back to a direct HTTP call when it isn't.
 *
 * Reads only, by design. The daemon authorizes every proxied call with its
 * OWN process token — the socket envelope carries no per-request caller token
 * — so routing a WRITE through it could attribute a mutation to the wrong org
 * when one user drives several org-bound sessions under a single daemon.
 * Writes (moves ingest, reconcile issue, confirm) therefore stay on the
 * direct, per-invocation client, which resolves the caller's token itself.
 * The same single-token caveat permits a cross-org READ, but a read is
 * non-mutating; tightening it to a per-request principal is a tracked
 * follow-up.
 */
import type { CliClient } from "../client.js";
import { daemonRequest } from "./client.js";

const DAEMON_HTTP_TIMEOUT_MS = 10_000;
// The daemon is a LOCAL socket; a warm proxy answers in tens of ms. Probe it
// on a short budget rather than the full HTTP deadline — otherwise the common
// no-daemon cold path waits the daemon timeout AND the direct timeout (~2x).
// Reads are idempotent, so a daemon that answers after we've already fallen
// back is harmless.
const DAEMON_PROBE_TIMEOUT_MS = 250;

async function daemonOrDirect<T>(
  method: string,
  params: Record<string, unknown>,
  direct: () => Promise<T>,
): Promise<T> {
  const fromDaemon = await daemonRequest<T>(method, params, {
    timeoutMs: DAEMON_PROBE_TIMEOUT_MS,
  });
  if (fromDaemon !== null) {
    return fromDaemon;
  }
  return await direct();
}

export async function daemonOrDirectGet<T>(
  method: string,
  path: string,
  client: CliClient,
  timeoutMs = DAEMON_HTTP_TIMEOUT_MS,
): Promise<T> {
  return await daemonOrDirect<T>(
    method,
    { path },
    async () =>
      (await client.get(path, {
        signal: AbortSignal.timeout(timeoutMs),
      })) as T,
  );
}
