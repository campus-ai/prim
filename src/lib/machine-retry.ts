import { createHash } from "node:crypto";
import { lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { MachineAuthError } from "./machine-protocol.js";

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
      "Machine authentication is cooling down after a temporary failure. Retry later.",
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
      atomicWriteFile(path, JSON.stringify({ failures, retryAt }), { mode: 0o600 });
      throw new MachineAuthError(error.code, error.message, false, retryAt);
    }
    throw error;
  }
}
