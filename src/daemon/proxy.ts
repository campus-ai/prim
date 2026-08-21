/**
 * Daemon-first transport for the prim decision READS.
 *
 * Routes the idempotent, latency-sensitive decision reads (recent / show /
 * cascade / affecting) through the long-lived prim-daemon's warm connection
 * when it's up, falling back to a direct HTTP call when it isn't.
 *
 * Reads only, by design. Each socket envelope carries a non-secret proof of
 * the caller's current principal, organization, and credential generation;
 * the daemon serves a read only when that proof matches its current bearer.
 * Missing, opaque, stale, or cross-org proofs fail soft into the direct path.
 * Writes remain direct so their bearer is resolved in the invoking process.
 */
import { type CliClient, getSiteUrl } from "../client.js";
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
  // Carry the caller's resolved env so a daemon bound to a different deployment
  // refuses (returns ok:false → null here) and we fall through to a direct call
  // against our own env, instead of being served another deployment's data.
  const fromDaemon = await daemonRequest<T>(
    method,
    { ...params, callerEnv: getSiteUrl() },
    { timeoutMs: DAEMON_PROBE_TIMEOUT_MS },
  );
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
