/**
 * Opportunistic journal drain for ordinary CLI invocations.
 *
 * Every command except uninstall and `moves flush` itself offers to drain an
 * overdue journal. Draining in-process kept the command alive until the whole
 * sweep finished, because index.ts ends in `program.parse()` and most commands
 * return instead of exiting. Behind a large backlog (PRI-68) each step `prim
 * setup` runs through spawnSync therefore waited on a full drain. The drain is
 * instead handed to the same detached `prim moves flush` the Stop and
 * post-commit hooks spawn. The cross-process flush lock already serializes it
 * with the daemon and every other drain, so a redundant child simply bows out.
 */
import { type SpawnOptions, spawn } from "node:child_process";
import { journalNeedsFlush } from "../flusher.js";
import { binFile } from "./bin-path.js";

type SpawnedProcess = {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};
type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

export type BackgroundFlushOptions = {
  needsFlush?: () => boolean;
  primEntry?: string | null;
  nodeEntry?: string;
  spawnProcess?: SpawnProcess;
};

/**
 * Start a detached `prim moves flush` when the journal holds overdue Moves.
 * Never throws, prints, or waits; returns whether a child was started.
 */
export function startBackgroundFlush(options: BackgroundFlushOptions = {}): boolean {
  try {
    if (!(options.needsFlush ?? journalNeedsFlush)()) return false;
    // binFile and this process resolve the same package root, so the child
    // drains with exactly this CLI's flusher.
    const primEntry = options.primEntry === undefined ? binFile("prim") : options.primEntry;
    if (!primEntry) return false;
    const child = (options.spawnProcess ?? (spawn as SpawnProcess))(
      options.nodeEntry ?? process.execPath,
      [primEntry, "moves", "flush"],
      // Ignored stdio matters as much as detaching: a child holding inherited
      // pipes would keep a caller that captures them (spawnSync) waiting.
      { detached: true, stdio: "ignore" },
    );
    // An asynchronous spawn failure (EAGAIN, EMFILE) is emitted as an event;
    // unhandled, it would crash the command this drain must never affect.
    child.once("error", () => {});
    child.unref();
    return true;
  } catch {
    // Opportunistic flush must never break a CLI command.
    return false;
  }
}
