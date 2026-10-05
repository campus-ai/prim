/**
 * Attended, upgrade-only repair of a supervised daemon left behind by its CLI.
 *
 * Only SessionStart, explicit `prim daemon` lifecycle commands, and `prim
 * setup` run `daemon ensure`, and SessionStart deliberately ensures the
 * version of its pinned hook runtime. A user who runs a newer CLI therefore
 * keeps an older daemon indefinitely, while `daemon status` and `doctor` only
 * report the drift. An allowlisted, attended invocation of a newer CLI (see
 * startup-background.ts) instead hands the upgrade to a detached `daemon
 * ensure` (the same idempotent, lock-serialized path SessionStart uses)
 * without delaying or altering the command itself.
 *
 * The same CLI also repairs a launcher at its own version that can no longer
 * run. A launcher newer than the hook runtime (for example, one a heal
 * installed) is retained by SessionStart's ensure, which refuses to downgrade
 * it even after its pinned node has been deleted. An ensure at the
 * launcher's own version restages it instead.
 */
import { getSiteUrlForEnvironment } from "../client.js";
import { atomicWriteFile } from "../lib/atomic-file.js";
import { binFile, packageRoot, packageVersion } from "../lib/bin-path.js";
import { readBoundedRegularFile } from "../lib/bounded-file.js";
import { withFileLockSync } from "../lib/file-lock.js";
import { compareSemver } from "../lib/semver.js";
import { apiUrlsMatch } from "./env-binding.js";
import {
  type SelectedDaemonLauncher,
  daemonDriftHealClaimPath,
  daemonDriftHealMarkerPath,
  daemonExplicitlyDisabled,
  launchAgentRunsConfigRoot,
  selectedDaemonLauncher,
} from "./launchd.js";
import { type DaemonEnsureOptions, kickDaemonEnsure } from "./self-heal.js";

const ATTEMPT_MARKER_MODE = 0o600;
const ATTEMPT_MARKER_MAX_BYTES = 1_024;
const PATH_SEPARATORS = /[\\/]/u;
// Exactly "0" turns the heal off, like PRIM_BIN_CACHE=0 for the bin cache.
export const DAEMON_DRIFT_HEAL_ENV = "PRIM_DAEMON_DRIFT_HEAL";
// An ensure that fails before it rewrites the launcher (the runtime cannot be
// staged, the lifecycle lock is held, the package vanished from an npx cache)
// leaves the launcher as it was, so without this window every later command
// would respawn the same failing child. Ensure rewrites the launcher before it
// calls launchctl, so a launchctl refusal leaves the launcher current and the
// version check alone stops retrying. Any attempt holds the window, whatever
// version it targeted: two installed CLIs at different versions (a global
// install and an npx cache) would otherwise alternate past it while ensure
// keeps failing. A newer CLI therefore waits out at most this window.
export const DAEMON_DRIFT_HEAL_RETRY_MS = 60 * 60 * 1_000;

type DriftHealAttempt = { attemptedAt: number; fromVersion: string; toVersion: string };

export type DaemonDriftHealOptions = Omit<DaemonEnsureOptions, "latestBootstrap"> & {
  /** Resolves the config root and deployment; the child inherits process.env. */
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  cliVersion?: string | null;
  /** Root of the running package; a checkout outside node_modules never heals. */
  packageRoot?: string | null;
  /** Effective uid of this process. */
  euid?: number;
  nowMs?: () => number;
  selectedLauncher?: () => SelectedDaemonLauncher | null;
  /** Whether the per-user LaunchAgent runs the launcher this config root selects. */
  launchAgentRunsConfigRoot?: () => boolean;
};

function readAttempt(path: string): DriftHealAttempt | null {
  // Startup must never block on a FIFO or read an unbounded file here. An
  // unusable record counts as absent and is atomically replaced below.
  const file = readBoundedRegularFile(path, ATTEMPT_MARKER_MAX_BYTES);
  if (!file) return null;
  try {
    const value = JSON.parse(file.text) as unknown;
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

/** Never wait for another command's claim; withFileLockSync sleeps only to wait. */
function claimHeld(): never {
  throw new Error("another command holds the daemon drift-heal claim");
}

/**
 * Record `attempt` unless any attempt, for any target version, falls within
 * the retry window. Runs under the claim. A future timestamp (the clock moved
 * backwards) counts as stale and is re-anchored.
 */
function claimAttempt(markerPath: string, attempt: DriftHealAttempt): boolean {
  const previous = readAttempt(markerPath);
  const elapsed = previous ? attempt.attemptedAt - previous.attemptedAt : Number.POSITIVE_INFINITY;
  if (elapsed >= 0 && elapsed < DAEMON_DRIFT_HEAL_RETRY_MS) return false;
  atomicWriteFile(markerPath, `${JSON.stringify(attempt)}\n`, { mode: ATTEMPT_MARKER_MODE });
  return true;
}

/** A published install lives under node_modules (global, npx cache, or project). */
function isInstalledPackage(root: string | null): boolean {
  return root?.split(PATH_SEPARATORS).includes("node_modules") === true;
}

/**
 * Strictly older, or the same version but no longer runnable. Equal and
 * runnable needs nothing, and ensure itself retains a newer or incomparable
 * runtime rather than downgrading it, so neither is ever healed from here.
 */
function needsHeal(launcher: SelectedDaemonLauncher, toVersion: string): boolean {
  const order = compareSemver(launcher.runtimeVersion, toVersion);
  return order === -1 || (order === 0 && !launcher.runnable);
}

function startDriftHeal(options: DaemonDriftHealOptions): boolean {
  // Only launchd supervision records a selected runtime. Elsewhere `daemon
  // ensure` merely starts a missing detached process and never replaces a live
  // one, so there is no drift it could repair.
  if ((options.platform ?? process.platform) !== "darwin") return false;
  const env = options.env ?? process.env;
  if (env[DAEMON_DRIFT_HEAL_ENV] === "0") return false;
  // A git checkout or `node dist/index.js` in a worktree is a development
  // build: it must never replace the daemon a real install supervises.
  const root = options.packageRoot === undefined ? packageRoot() : options.packageRoot;
  if (!isInstalledPackage(root)) return false;
  // Under sudo HOME can still name the user's tree, and a root-run ensure
  // would leave root-owned launcher, plist, and runtime files in it.
  const euid = options.euid ?? process.geteuid?.();
  if (euid === undefined || euid === 0) return false;
  const paths = { env, homeDir: options.homeDir };
  // The child ensure honors an explicit stop too; checking first avoids a
  // pointless spawn on every command while the daemon is opted out.
  if (daemonExplicitlyDisabled(paths)) return false;
  const launcher = (options.selectedLauncher ?? (() => selectedDaemonLauncher(paths)))();
  if (!launcher || launcher.ownerUid !== euid) return false;
  const toVersion = options.cliVersion === undefined ? packageVersion() : options.cliVersion;
  if (!(toVersion && needsHeal(launcher, toVersion))) return false;
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
  // Nor its config root: launchd runs one per-user LaunchAgent, and an ensure
  // from another root would repoint it at that root's launcher.
  const runsConfigRoot =
    options.launchAgentRunsConfigRoot ?? (() => launchAgentRunsConfigRoot(paths));
  if (!runsConfigRoot()) return false;
  // binFile and packageVersion resolve the same package root, so the child
  // ensures exactly toVersion, even from an npx cache.
  const primEntry = options.primEntry === undefined ? binFile("prim") : options.primEntry;
  if (!primEntry) return false;

  const attempt: DriftHealAttempt = {
    attemptedAt: (options.nowMs ?? Date.now)(),
    fromVersion: launcher.runtimeVersion,
    toVersion,
  };
  // Commands that start together (an agent running several at once) would
  // otherwise all find the window open and each spawn a child. The claim makes
  // checking and renewing the record one step, and it is never waited on: a
  // held claim means another command is deciding now, so this one starts
  // nothing. A claim or record that cannot be written throws, and nothing
  // starts either, because an unrecorded attempt cannot be rate limited.
  const claimed = withFileLockSync(
    daemonDriftHealClaimPath(paths),
    () => claimAttempt(daemonDriftHealMarkerPath(paths), attempt),
    { timeoutMs: 0, sleep: claimHeld },
  );
  if (!claimed) return false;
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
 * runtime strictly older than this CLI, or one at this CLI's version that can
 * no longer run. Never throws, prints, or waits; returns whether a child was
 * started.
 */
export function healDaemonDrift(options: DaemonDriftHealOptions = {}): boolean {
  try {
    return startDriftHeal(options);
  } catch {
    return false;
  }
}
