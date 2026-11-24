import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { cloudSetupPointer, isClaudeCloudSession } from "./cloud-env.js";
import { MachineAuthError } from "./machine-protocol.js";

/**
 * Forget prim's own backoff, so an explicit check retries now and reports the
 * failure itself. A backoff outlives its cause: after the user allows a
 * blocked host, "cooling down" would otherwise be all prim says for a minute.
 * A wait the server asked for (Retry-After) is not prim's to forget.
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
      const state = JSON.parse(readFileSync(path, "utf8")) as { serverRetryAfter?: unknown };
      if (state.serverRetryAfter === true) continue;
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

/** Call while holding credentials.lock. This file contains no credentials or tokens. */
export async function withMachineCooldown<T>(
  directory: string,
  apiUrl: string,
  clientId: string,
  signal: AbortSignal | undefined,
  request: () => Promise<T>,
): Promise<T> {
  signal?.throwIfAborted();
  const key = createHash("sha256").update(`${apiUrl}\0${clientId}`).digest("hex");
  const path = join(directory, `machine_retry_${key}.json`);
  let state = { failures: 0, retryAt: 0 };
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
    state = data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT")
      throw new MachineAuthError("invalid_storage", "Machine retry state is unreadable.");
  }
  if (state.retryAt > Date.now())
    throw new MachineAuthError(
      "token_service_unavailable",
      // The cooldown hides the failure that started it; cloud setup retries
      // at once and names the cause.
      isClaudeCloudSession()
        ? cloudSetupPointer("Machine authentication is cooling down after a temporary failure")
        : "Machine authentication is cooling down after a temporary failure. Retry later.",
      false,
      state.retryAt,
    );
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
        "token_service_unavailable",
        "verification_unavailable",
        "discovery_unavailable",
      ].includes(error.code)
    ) {
      const failures = Math.min(16, state.failures + 1);
      const backoff = Math.min(60_000, 1000 * 2 ** (failures - 1));
      const retryAt = error.retryAt ?? Date.now() + Math.ceil(backoff * (1 + Math.random()));
      atomicWriteFile(
        path,
        JSON.stringify({
          failures,
          retryAt,
          ...(error.retryAt === undefined ? {} : { serverRetryAfter: true }),
        }),
        { mode: 0o600 },
      );
      throw new MachineAuthError(error.code, error.message, false, retryAt);
    }
    throw error;
  }
}
