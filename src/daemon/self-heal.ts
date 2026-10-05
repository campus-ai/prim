import { type SpawnOptions, spawn } from "node:child_process";
import { binFile } from "../lib/bin-path.js";
import { unattendedEnv } from "../lib/unattended.js";

type SpawnedProcess = {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};
type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

export type DaemonEnsureOptions = {
  platform?: NodeJS.Platform;
  primEntry?: string | null;
  nodeEntry?: string;
  spawnProcess?: SpawnProcess;
  /**
   * Follow the local ensure with the pinned registry revalidation. Defaults to
   * the SessionStart behavior (macOS only). Attended drift healing opts out:
   * the invoking CLI already holds the newer bytes locally.
   */
  latestBootstrap?: boolean;
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
    if (options.latestBootstrap ?? (options.platform ?? process.platform) === "darwin") {
      args.push("--latest-bootstrap");
    }
    const child = (options.spawnProcess ?? (spawn as SpawnProcess))(
      options.nodeEntry ?? process.execPath,
      args,
      // Unattended: neither SessionStart's repair nor a drift heal is a person
      // running prim, so the child (and its descendants) never heal in turn.
      { detached: true, stdio: "ignore", env: unattendedEnv() },
    );
    // An asynchronous spawn failure (EAGAIN, EMFILE) is emitted as an event;
    // unhandled, it would crash the hook or command that asked for the repair.
    child.once("error", () => {});
    child.unref();
    return true;
  } catch {
    return false;
  }
}
