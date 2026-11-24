import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { cloudSetupPointer } from "./cloud-env.js";
import { MachineAuthError, proxyFault } from "./machine-protocol.js";

/**
 * Forget every cooldown, so an explicit check retries now and reports the
 * failure itself. A cooldown outlives its cause: after the user allows a
 * blocked host, "cooling down" would otherwise be all prim says for a minute.
 */
export function clearMachineCooldowns(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names)
    if (/^machine_retry_[0-9a-f]{64}\.json$/u.test(name))
      rmSync(join(directory, name), { force: true });
}

type RetryState = { failures: number; retryAt: number; proxy?: boolean };

function retryPath(directory: string, apiUrl: string, clientId: string): string {
  const key = createHash("sha256").update(`${apiUrl}\0${clientId}`).digest("hex");
  return join(directory, `machine_retry_${key}.json`);
}

function readRetryState(path: string): RetryState {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > 1024) throw new Error("Invalid retry state");
    const data = JSON.parse(readFileSync(path, "utf8"));
    if (
      !Number.isSafeInteger(data.failures) ||
      data.failures < 0 ||
      data.failures > 16 ||
      !Number.isSafeInteger(data.retryAt) ||
      data.retryAt < 0
    )
      throw new Error("Invalid retry state");
    return data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new MachineAuthError("invalid_storage", "Machine retry state is unreadable.");
    return { failures: 0, retryAt: 0 };
  }
}

/** One more failure: each doubles the wait, up to a minute or two. */
function recordFailure(path: string, state: RetryState, proxy: boolean, until?: number): number {
  const failures = Math.min(16, state.failures + 1);
  const backoff = Math.min(60_000, 1000 * 2 ** (failures - 1));
  const retryAt = until ?? Date.now() + Math.ceil(backoff * (1 + Math.random()));
  atomicWriteFile(path, JSON.stringify({ failures, retryAt, ...(proxy ? { proxy: true } : {}) }), {
    mode: 0o600,
  });
  return retryAt;
}

/**
 * Start a cooldown from outside a request: the token broker is giving up
 * because the environment's proxy has it reconnecting without end (see
 * onRunawayConnections). Whatever starts next waits it out, and says why.
 */
export function recordProxyFailure(directory: string, apiUrl: string, clientId: string): void {
  const path = retryPath(directory, apiUrl, clientId);
  let state: RetryState = { failures: 0, retryAt: 0 };
  try {
    state = readRetryState(path);
  } catch {
    // Unreadable state is replaced; this process is about to exit.
  }
  recordFailure(path, state, true);
}

/** The proxy's fault, if a cooldown for one is running: why a broker is gone. */
export function proxyCooldown(
  directory: string,
  apiUrl: string,
  clientId: string,
): MachineAuthError | undefined {
  try {
    const state = readRetryState(retryPath(directory, apiUrl, clientId));
    return state.proxy && state.retryAt > Date.now() ? proxyFault(state.retryAt) : undefined;
  } catch {
    return undefined;
  }
}

/** Call while holding credentials.lock. This file contains no credentials or tokens. */
export async function withMachineCooldown<T>(
  directory: string,
  apiUrl: string,
  clientId: string,
  signal: AbortSignal | undefined,
  request: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const path = retryPath(directory, apiUrl, clientId);
  const state = readRetryState(path);
  if (state.retryAt > Date.now()) {
    // A proxy that is failing is named: no setup step repairs it.
    if (state.proxy) throw proxyFault(state.retryAt);
    throw new MachineAuthError(
      "token_service_unavailable",
      // The cooldown hides the failure that started it; cloud setup retries
      // at once and names the cause.
      cloudSetupPointer(
        "Machine authentication is cooling down after a temporary failure. Retry later.",
      ),
      false,
      state.retryAt,
    );
  }
  try {
    const result = await request();
    rmSync(path, { force: true });
    return result;
  } catch (error) {
    if (
      !signal?.aborted &&
      error instanceof MachineAuthError &&
      [
        "authentication_unavailable",
        "proxy_unavailable",
        "token_service_unavailable",
        "verification_unavailable",
        "discovery_unavailable",
      ].includes(error.code)
    ) {
      const retryAt = recordFailure(path, state, error.code === "proxy_unavailable", error.retryAt);
      throw new MachineAuthError(error.code, error.message, false, retryAt);
    }
    throw error;
  }
}
