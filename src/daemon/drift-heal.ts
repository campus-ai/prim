/**
 * Attended, upgrade-only repair of a supervised daemon left behind by its CLI.
 *
 * Only SessionStart, explicit `prim daemon` lifecycle commands, and `prim
 * setup` run `daemon ensure`, and SessionStart deliberately ensures the
 * version of its pinned hook runtime. A user who runs a newer CLI therefore
 * keeps an older daemon indefinitely, while `daemon status` and `doctor` only
 * report the drift. Any attended invocation of a newer CLI instead hands the
 * upgrade to a detached `daemon ensure` (the same idempotent, lock-serialized
 * path SessionStart uses) without delaying or altering the command itself.
 */
import { lstatSync, readFileSync } from "node:fs";
import { getSiteUrlForEnvironment } from "../client.js";
import { atomicWriteFile } from "../lib/atomic-file.js";
import { binFile, packageVersion } from "../lib/bin-path.js";
import { compareSemver } from "../lib/semver.js";
import { apiUrlsMatch } from "./env-binding.js";
import {
  daemonDriftHealMarkerPath,
  daemonExplicitlyDisabled,
  selectedDaemonLauncher,
} from "./launchd.js";
import { type DaemonEnsureOptions, kickDaemonEnsure } from "./self-heal.js";

const ATTEMPT_MARKER_MODE = 0o600;
const ATTEMPT_MARKER_MAX_BYTES = 1_024;
// A failing ensure (launchctl refusal, corrupt incumbent, vanished bundle)
// leaves the launcher older, so without this window every later command would
// respawn the same failing child. Keying the window on the target version
// still lets a newer CLI try at once.
export const DAEMON_DRIFT_HEAL_RETRY_MS = 60 * 60 * 1_000;

type SelectedLauncher = { runtimeVersion: string; apiUrl?: string };

type DriftHealAttempt = { attemptedAt: number; fromVersion: string; toVersion: string };

export type DaemonDriftHealOptions = Omit<DaemonEnsureOptions, "latestBootstrap"> & {
  /** Resolves the config root and deployment; the child inherits process.env. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliVersion?: string | null;
  nowMs?: () => number;
  selectedLauncher?: () => SelectedLauncher | null;
};

function readAttempt(path: string): DriftHealAttempt | null {
  try {
    const metadata = lstatSync(path);
    // Startup must never block on a FIFO or read an unbounded file here. An
    // unusable record counts as absent and is atomically replaced below.
    if (!metadata.isFile() || metadata.size > ATTEMPT_MARKER_MAX_BYTES) return null;
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (typeof value !== "object" || value === null) return null;
    const attempt = value as Partial<DriftHealAttempt>;
    return typeof attempt.attemptedAt === "number" &&
      Number.isFinite(attempt.attemptedAt) &&
      typeof attempt.fromVersion === "string" &&
      typeof attempt.toVersion === "string"
      ? (attempt as DriftHealAttempt)
      : null;
  } catch {
    return null;
  }
}

function startDriftHeal(options: DaemonDriftHealOptions): boolean {
  // Only launchd supervision records a selected runtime. Elsewhere `daemon
  // ensure` merely starts a missing detached process and never replaces a live
  // one, so there is no drift it could repair.
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const env = options.env ?? process.env;
  const paths = { env, homeDir: options.homeDir };
  // The child ensure honors an explicit stop too; checking first avoids a
  // pointless spawn on every command while the daemon is opted out.
  if (daemonExplicitlyDisabled(paths)) return false;
  const launcher = (options.selectedLauncher ?? (() => selectedDaemonLauncher(paths)))();
  const toVersion = options.cliVersion === undefined ? packageVersion() : options.cliVersion;
  // Strictly older only. Equal needs nothing, and ensure itself retains a
  // newer or incomparable runtime rather than downgrading it.
  if (!launcher || !toVersion || compareSemver(launcher.runtimeVersion, toVersion) !== -1) {
    return false;
  }
  // Heal the version and nothing else. Ensure derives the daemon's deployment
  // from the inherited PRIM_API_URL, so a one-off command aimed at another
  // deployment must not silently retarget the daemon.
  if (
    !apiUrlsMatch(
      getSiteUrlForEnvironment(launcher.apiUrl),
      getSiteUrlForEnvironment(env.PRIM_API_URL),
    )
  ) {
    return false;
  }
  // binFile and packageVersion resolve the same package root, so the child
  // ensures exactly toVersion, even from an npx cache.
  const primEntry = options.primEntry === undefined ? binFile("prim") : options.primEntry;
  if (!primEntry) return false;

  const markerPath = daemonDriftHealMarkerPath(paths);
  const now = (options.nowMs ?? Date.now)();
  const previous = readAttempt(markerPath);
  // A future timestamp (the clock moved backwards) counts as stale; the record
  // written below re-anchors it.
  const elapsed = previous ? now - previous.attemptedAt : Number.POSITIVE_INFINITY;
  if (previous?.toVersion === toVersion && elapsed >= 0 && elapsed < DAEMON_DRIFT_HEAL_RETRY_MS) {
    return false;
  }
  // Record before spawning: an attempt that cannot be recorded cannot be rate
  // limited, so a failed write throws and nothing starts. Two concurrent first
  // commands may both get here; ensure's lifecycle lock serializes them and the
  // second finds the upgrade already applied.
  const attempt: DriftHealAttempt = {
    attemptedAt: now,
    fromVersion: launcher.runtimeVersion,
    toVersion,
  };
  atomicWriteFile(markerPath, `${JSON.stringify(attempt)}\n`, { mode: ATTEMPT_MARKER_MODE });
  // The local ensure is the whole upgrade: this CLI already holds the newer
  // daemon bytes, so the SessionStart registry revalidation would be redundant.
  return kickDaemonEnsure({
    primEntry,
    nodeEntry: options.nodeEntry,
    spawnProcess: options.spawnProcess,
    latestBootstrap: false,
  });
}

/**
 * Start a detached `daemon ensure` when the supervised launcher selects a
 * runtime strictly older than this CLI. Never throws, prints, or waits;
 * returns whether a child was started.
 */
export function healDaemonDrift(options: DaemonDriftHealOptions = {}): boolean {
  try {
    return startDriftHeal(options);
  } catch {
    return false;
  }
}
