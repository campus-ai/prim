import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { cloudSetupPointer, isClaudeCloudSession } from "./cloud-env.js";
import { MachineAuthError, proxyFault } from "./machine-protocol.js";

/**
 * A cooldown is one of three things, and each is told and cleared its own
 * way. Prim's own backoff after a failure. A wait the token service asked for
 * with Retry-After (`serverRetryAfter`). A failure of the environment's proxy
 * (`proxy`), which may have had the token broker reconnecting without end.
 */
type RetryState = {
  failures: number;
  retryAt: number;
  serverRetryAfter?: unknown;
  proxy?: unknown;
};

/**
 * Forget prim's own backoff, so an explicit check retries now and reports the
 * failure itself. A backoff outlives its cause: after the user allows a
 * blocked host, "cooling down" would otherwise be all prim says for a minute.
 * A wait the server asked for (Retry-After) is not prim's to forget.
 *
 * A proxy's failure is asked about again at once, since the explicit check is
 * the user asking whether it is fixed, but it is not forgotten: its count of
 * failures stays. If the proxy is still failing, the check costs one attempt
 * (which the broker cuts short, see onRunawayConnections) and the wait that
 * follows is longer than the last, instead of starting over at a second.
 */
export function clearMachineCooldowns(directory: string): void {
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    if (!/^machine_retry_[0-9a-f]{64}\.json$/u.test(name)) continue;
    const path = join(directory, name);
    try {
      const state = JSON.parse(readFileSync(path, "utf8")) as Partial<RetryState>;
      if (state.serverRetryAfter === true) continue;
      if (state.proxy === true && Number.isSafeInteger(state.failures)) {
        atomicWriteFile(
          path,
          JSON.stringify({ failures: state.failures, retryAt: 0, proxy: true }),
          { mode: 0o600 },
        );
        continue;
      }
    } catch {
      // Unreadable state is no reason to keep waiting.
    }
    try {
      rmSync(path, { force: true });
    } catch {
      // The check still runs; it reports the cooldown if one remains.
    }
  }
}

/**
 * How a wait the server asked for begins. It is neither prim's backoff nor a
 * network fault, so nothing about the environment fixes it: only the wait does.
 */
export const SERVER_WAIT_PREFIX = "The sign-in service asked prim to wait";

/** A Retry-After is honoured, but not one that would outlast the session by years. */
const MAX_SERVER_WAIT_MS = 15 * 60_000;

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

/**
 * One more failure. A wait the server asked for is kept as asked, up to the
 * cap; otherwise each failure doubles prim's own wait, up to a minute or two.
 */
function recordFailure(
  path: string,
  state: RetryState,
  proxy: boolean,
  serverRetryAt?: number,
): number {
  const failures = Math.min(16, state.failures + 1);
  const backoff = Math.min(60_000, 1000 * 2 ** (failures - 1));
  const retryAt =
    serverRetryAt === undefined
      ? Date.now() + Math.ceil(backoff * (1 + Math.random()))
      : Math.min(serverRetryAt, Date.now() + MAX_SERVER_WAIT_MS);
  atomicWriteFile(
    path,
    JSON.stringify({
      failures,
      retryAt,
      ...(serverRetryAt === undefined ? {} : { serverRetryAfter: true }),
      ...(proxy ? { proxy: true } : {}),
    }),
    { mode: 0o600 },
  );
  return retryAt;
}

/**
 * Start a cooldown from outside a request: the token broker is giving up
 * because the environment's proxy has it reconnecting without end (see
 * onRunawayConnections). Whatever starts next waits it out, and says why. A
 * wait the server asked for, if one is running, still stands as asked.
 */
export function recordProxyFailure(directory: string, apiUrl: string, clientId: string): void {
  const path = retryPath(directory, apiUrl, clientId);
  let state: RetryState = { failures: 0, retryAt: 0 };
  try {
    state = readRetryState(path);
  } catch {
    // Unreadable state is replaced; this process is about to exit.
  }
  const serverWait = state.serverRetryAfter === true && state.retryAt > Date.now();
  recordFailure(path, state, true, serverWait ? state.retryAt : undefined);
}

/**
 * The proxy's fault, if a cloud session has a cooldown for one running: why
 * a broker that gave up is gone.
 */
export function proxyCooldown(
  directory: string,
  apiUrl: string,
  clientId: string,
): MachineAuthError | undefined {
  try {
    const state = readRetryState(retryPath(directory, apiUrl, clientId));
    return state.proxy === true && state.retryAt > Date.now() && isClaudeCloudSession()
      ? proxyFault(state.retryAt)
      : undefined;
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
    // A failing proxy is named for what it is: only the proxy recovering ends it.
    if (state.proxy === true && isClaudeCloudSession()) throw proxyFault(state.retryAt);
    throw new MachineAuthError(
      "token_service_unavailable",
      !isClaudeCloudSession()
        ? "Machine authentication is cooling down after a temporary failure. Retry later."
        : state.serverRetryAfter === true
          ? // Cloud setup keeps this wait too, so pointing at it would loop.
            `${SERVER_WAIT_PREFIX}; retry in about ${Math.ceil((state.retryAt - Date.now()) / 1000)}s`
          : // The cooldown hides the failure that started it; cloud setup
            // retries at once and names the cause.
            cloudSetupPointer("Machine authentication is cooling down after a temporary failure"),
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
