import { type SpawnOptions, spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { pinnedNpxArgs } from "../lib/bin-path.js";
import { withFileLock } from "../lib/file-lock.js";

const LATEST_BOOTSTRAP_TIMEOUT_MS = 45_000;
const LATEST_BOOTSTRAP_LOCK_NAME = "daemon-latest.lock";

interface SpawnedLatest {
  kill(signal?: NodeJS.Signals): boolean;
  once(event: "error", listener: () => void): this;
  once(event: "exit", listener: (code: number | null) => void): this;
}

type SpawnLatest = (command: string, args: string[], options: SpawnOptions) => SpawnedLatest;

export interface LatestDaemonBootstrapOptions {
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  lockPath?: string;
  spawnProcess?: SpawnLatest;
  timeoutMs?: number;
}

export interface CurrentDaemonEnsureResult {
  disabled: boolean;
}

async function runPinnedEnsure(options: LatestDaemonBootstrapOptions): Promise<boolean> {
  const env = {
    ...(options.env ?? process.env),
    npm_config_prefer_online: "true",
    npm_config_fetch_retries: "1",
    npm_config_fetch_retry_mintimeout: "1000",
    npm_config_fetch_retry_maxtimeout: "5000",
    npm_config_fetch_timeout: "15000",
  };

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let child: SpawnedLatest;
    try {
      child = (options.spawnProcess ?? (spawn as unknown as SpawnLatest))(
        "npx",
        pinnedNpxArgs("prim", ["daemon", "ensure"], { preferOnline: true }),
        { env, stdio: "ignore" },
      );
    } catch {
      resolve(false);
      return;
    }

    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(false);
    }, options.timeoutMs ?? LATEST_BOOTSTRAP_TIMEOUT_MS);
    const finish = (result: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    timer.unref();
    child.once("error", () => finish(false));
    child.once("exit", (code) => finish(code === 0));
  });
}

/**
 * Serialize the SessionStart updater across all clients. The installed package
 * heals the daemon first so offline starts still work; only then does npm
 * revalidate the exact running package version and run its normal
 * (non-recursive) `daemon ensure`.
 */
export async function runLatestDaemonBootstrap(
  ensureCurrent: () => Promise<CurrentDaemonEnsureResult>,
  options: LatestDaemonBootstrapOptions = {},
): Promise<boolean> {
  const lockPath =
    options.lockPath ??
    join(options.homeDir ?? homedir(), ".config", "prim", LATEST_BOOTSTRAP_LOCK_NAME);
  try {
    return await withFileLock(
      lockPath,
      async () => {
        const current = await ensureCurrent();
        if (current.disabled) return true;
        return await runPinnedEnsure(options);
      },
      // A concurrent SessionStart already owns the complete bootstrap. Do not
      // queue another npm lookup behind it; the short window only permits one
      // retry after recovering a stale lock.
      { timeoutMs: 100, pollMs: 25 },
    );
  } catch {
    return false;
  }
}
