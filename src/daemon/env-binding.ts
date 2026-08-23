/**
 * Environment-binding check for the daemon read-proxy.
 *
 * The prim-daemon resolves ONE API base URL at boot (explicit PRIM_API_URL env
 * or default prod) and proxies the latency-sensitive decision reads from that
 * single upstream. Because the socket envelope only
 * carries the request path — not the caller's environment — a daemon bound to
 * one deployment (say staging) would otherwise answer a CLI invocation that
 * targets another (prod) with the wrong deployment's decisions.
 *
 * So an env-bound proxied call now carries the caller's resolved base URL, and
 * the daemon refuses it on mismatch; the caller treats the refusal as a
 * fall-through to a direct HTTP call against its own env. These pure helpers do
 * the comparison.
 */

export function normalizeApiUrl(url: string): string {
  // Trailing slashes and surrounding whitespace are not semantically
  // meaningful for the base URL, so they must not cause a spurious mismatch.
  return url.trim().replace(/\/+$/, "");
}

export function apiUrlsMatch(a: string, b: string): boolean {
  return normalizeApiUrl(a) === normalizeApiUrl(b);
}

/**
 * True when a caller targets a different deployment than `boundEnv` — the URL
 * the daemon's client currently resolves to, passed in fresh so it tracks the
 * actual upstream rather than a stale boot snapshot. A non-string `callerEnv`
 * (an older CLI that sends none) is never cross-env: served as before.
 *
 * Two consumers react differently: the proxied decision reads THROW (see
 * assertCallerEnvMatches) so the caller falls through to a direct call against
 * its own env; the presence snapshot WITHHOLDS its roster (presence has no
 * direct fallback — it lives in the daemon heartbeat) and flags the mismatch so
 * the statusline stays honest instead of showing another deployment's team.
 */
export function isCrossEnv(callerEnv: unknown, boundEnv: string): boolean {
  return typeof callerEnv === "string" && !apiUrlsMatch(callerEnv, boundEnv);
}

/**
 * Throw on a cross-env proxied read. The throw surfaces as `ok: false`, which the
 * socket client maps to `null`, so the caller falls through to a direct HTTP call
 * against its own env. Scope: recent/show/cascade/affecting + the conflict gate.
 */
export function assertCallerEnvMatches(callerEnv: unknown, boundEnv: string): void {
  if (isCrossEnv(callerEnv, boundEnv)) {
    throw new Error(`env mismatch: daemon is bound to ${boundEnv}, caller targets ${callerEnv}`);
  }
}
