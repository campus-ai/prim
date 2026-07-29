import { type SpawnOptions, spawn } from "node:child_process";
import { binFile } from "../lib/bin-path.js";

type SpawnedProcess = { unref(): void };
type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

export type DaemonEnsureOptions = {
  platform?: NodeJS.Platform;
  primEntry?: string | null;
  nodeEntry?: string;
  spawnProcess?: SpawnProcess;
};

/**
 * Ask a detached CLI process to repair/start the supervised daemon.
 * SessionStart hooks must never wait for launchctl or daemon readiness, so the
 * child owns the work and all failures stay fail-soft. `daemon ensure` itself
 * honors the explicit stop marker.
 */
export function kickDaemonEnsure(options: DaemonEnsureOptions = {}): boolean {
  const primEntry = options.primEntry === undefined ? binFile("prim") : options.primEntry;
  if (!primEntry) {
    return false;
  }

  try {
    const args = [primEntry, "daemon", "ensure"];
    if ((options.platform ?? process.platform) === "darwin") {
      args.push("--latest-bootstrap");
    }
    const child = (options.spawnProcess ?? (spawn as SpawnProcess))(
      options.nodeEntry ?? process.execPath,
      args,
      { detached: true, stdio: "ignore" },
    );
    child.unref();
    return true;
  } catch {
    return false;
  }
}
