/**
 * Opportunistic journal drain for ordinary CLI invocations.
 *
 * Every command except uninstall, setup, and `moves flush` itself offers to
 * drain an overdue journal. Draining in-process kept the command alive until
 * the whole sweep finished, because index.ts ends in `program.parse()` and
 * most commands return instead of exiting. Behind a large backlog (PRI-68)
 * each step `prim setup` runs through spawnSync therefore waited on a full
 * drain. The drain is instead handed to the same detached `prim moves flush`
 * the Stop and post-commit hooks spawn. The cross-process flush lock already
 * serializes it with the daemon and every other drain, so a redundant child
 * simply bows out. No child starts at all while a healthy daemon already owns
 * the drain: a bowed-out daemon sweep records nothing, so a child holding the
 * lock would only hide the daemon's own delivery record.
 */
import { type SpawnOptions, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { DAEMON_HEALTH_PATH, HEARTBEAT_FRESH_MS } from "../daemon/health.js";
import { journalNeedsFlush } from "../flusher.js";
import { binFile, packageVersion } from "./bin-path.js";
import { processIsAlive } from "./process-liveness.js";

type SpawnedProcess = {
  once(event: "error", listener: (error: Error) => void): unknown;
  unref(): void;
};
type SpawnProcess = (command: string, args: string[], options: SpawnOptions) => SpawnedProcess;

export type BackgroundFlushOptions = {
  needsFlush?: () => boolean;
  daemonOwnsDrain?: () => boolean;
  primEntry?: string | null;
  nodeEntry?: string;
  spawnProcess?: SpawnProcess;
};

export type DaemonDrainOwnerOptions = {
  healthPath?: string;
  now?: number;
  expectedVersion?: string | null;
  isAlive?: (pid: number) => boolean;
};

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Whether the daemon's persisted health shows it owns the drain: its process
 * is alive, it runs this CLI's version, its heartbeat succeeded recently with
 * no failure since, it is not held for re-auth, and it has recorded no
 * ingestion failure. Freshness is recomputed from the recorded timestamps
 * rather than trusted from the stored booleans, so a wedged or dead daemon
 * ages out. Any read, parse, or shape problem answers false: the caller then
 * starts its drain as before.
 */
export function daemonOwnsDrain(options: DaemonDrainOwnerOptions = {}): boolean {
  try {
    const expectedVersion =
      options.expectedVersion === undefined ? packageVersion() : options.expectedVersion;
    if (!expectedVersion) return false;
    const health = record(
      JSON.parse(readFileSync(options.healthPath ?? DAEMON_HEALTH_PATH, "utf8")),
    );
    const heartbeat = record(health?.heartbeat);
    const ingestion = record(health?.ingestion);
    if (!(health && heartbeat && ingestion)) return false;
    if (health.schemaVersion !== 1 || health.version !== expectedVersion) return false;
    if (health.needsReauth === true) return false;
    const pid = health.pid;
    if (typeof pid !== "number" || !(options.isAlive ?? processIsAlive)(pid)) return false;
    const lastSuccessAt = heartbeat.lastSuccessAt;
    const now = options.now ?? Date.now();
    return (
      heartbeat.consecutiveFailures === 0 &&
      typeof lastSuccessAt === "number" &&
      now - lastSuccessAt < HEARTBEAT_FRESH_MS &&
      ingestion.consecutiveFailures === 0
    );
  } catch {
    return false;
  }
}

/**
 * Start a detached `prim moves flush` when the journal holds overdue Moves
 * and no healthy daemon already owns the drain. Never throws, prints, or
 * waits; returns whether a child was started.
 */
export function startBackgroundFlush(options: BackgroundFlushOptions = {}): boolean {
  try {
    if ((options.daemonOwnsDrain ?? daemonOwnsDrain)()) return false;
    if (!(options.needsFlush ?? journalNeedsFlush)()) return false;
    // binFile resolves the `prim` bin of the package this process runs from.
    // From an installed CLI that is this CLI's own entry; from a source
    // checkout (tsx) it is that checkout's built dist entry instead.
    const primEntry = options.primEntry === undefined ? binFile("prim") : options.primEntry;
    if (!primEntry) return false;
    const child = (options.spawnProcess ?? (spawn as SpawnProcess))(
      options.nodeEntry ?? process.execPath,
      [primEntry, "moves", "flush"],
      // Ignored stdio matters as much as detaching: a child holding inherited
      // pipes would keep a caller that captures them (spawnSync) waiting.
      // windowsHide keeps the detached child from opening a console window.
      { detached: true, stdio: "ignore", windowsHide: true },
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
