/**
 * `prim doctor` — one-shot capture-pipeline health check.
 *
 * Answers "is decision capture actually working, end to end?" in a single
 * command, instead of forcing an operator to correlate `auth status`,
 * `daemon status`, `moves status`, and a filesystem listing by hand (the
 * ~20-minute archaeology the user study turned into). Checks auth, supervised
 * daemon health, durable queue age, stranded rotations, capture entitlement,
 * decision-feedback readiness, then renders them
 * verdict-first on STDERR with machine-readable JSON on STDOUT, exiting
 * non-zero when a check is red so an agent or installer can gate on it.
 *
 * AX contract: STDERR verdict-first; STDOUT machine-readable JSON.
 */

import { existsSync } from "node:fs";
import { type Command, Option } from "commander";
import {
  type AuthCredential,
  HttpError,
  REFRESH_TOKEN_PATH,
  getClient,
  getSiteUrl,
  getTokenExpiresAt,
  resolveAuthCredential,
} from "../client.js";
import { daemonRequest } from "../daemon/client.js";
import type { DaemonHeartbeatHealth, DaemonIngestionHealth } from "../daemon/health.js";
import {
  type LaunchdService,
  daemonExplicitlyDisabled,
  getLaunchdService,
} from "../daemon/launchd.js";
import { fetchFeedbackCapability } from "../decisions/feedback.js";
import {
  type RetainedJournalBucket,
  inspectJournalDelivery,
  summarizeRetainedBuckets,
} from "../journal-organization.js";
import {
  type PendingJournalStats,
  listBuckets,
  listFlushing,
  pendingJournalStats,
} from "../journal.js";
import {
  decisionIngestionStatus,
  isRepoActiveForCapture,
  isValidRepoSyncId,
  repoSyncId,
} from "../lib/activation.js";
import { boundedHealthError } from "../lib/ansi.js";
import { type HookCommandResolution, packageVersion } from "../lib/bin-path.js";
import {
  POST_COMMIT_GRACE_MS,
  type PostCommitFiring,
  inspectPostCommitFiring,
} from "../lib/commit-heartbeat.js";
import {
  MS_PER_SECOND,
  type PendingBacklog,
  deliveryBacklogState,
  deliveryBacklogSummary,
  formatPendingBacklog,
} from "../lib/delivery-backlog.js";
import {
  type ManagedGitHookName,
  type ManagedHookInspection,
  externalHookRemedy,
  inspectEffectiveGitHook,
} from "../lib/git-hooks.js";
import { gitToplevel } from "../lib/git.js";
import { type HookRuntimeInspection, inspectHookRuntime } from "../lib/hook-runtime.js";
import {
  type RepositoryBindingResult,
  resolveRepositoryBinding,
} from "../lib/repository-binding.js";
import { compareSemver } from "../lib/semver.js";
import {
  inspectHookRuntimeResolutions as claudeHookRuntimeResolutions,
  performStatus as claudeStatus,
} from "./claude-install.js";
import {
  inspectHookRuntimeResolutions as codexHookRuntimeResolutions,
  performStatus as codexStatus,
  uncoveredWorktreeAdvice,
  uncoveredWorktreeHooks,
} from "./codex-install.js";
import {
  inspectHookRuntimeResolutions as cursorHookRuntimeResolutions,
  performStatus as cursorStatus,
} from "./cursor-install.js";
import {
  inspectHookRuntimeResolutions as hermesHookRuntimeResolutions,
  performStatus as hermesStatus,
} from "./hermes-install.js";

const DAEMON_PROBE_TIMEOUT_MS = 500;
const CONNECTIVITY_TIMEOUT_MS = 3_000;
// User-facing durability contract: a captured Move should be durably ingested
// within 30 seconds. The daemon uses the same threshold in its health state.
const STALE_PENDING_MS = 30_000;
const EXIT_UNHEALTHY = 1;

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };

export type DoctorVerdict = {
  json: { ok: boolean; status: CheckStatus; checks: Check[] };
  exitCode: number;
};

export type DaemonDoctorSnapshot = {
  pid?: number;
  version?: string;
  healthy?: boolean;
  needsReauth?: boolean;
  envMismatch?: boolean;
  principalMismatch?: boolean;
  heartbeat?: DaemonHeartbeatHealth;
  ingestion?: DaemonIngestionHealth;
};

/**
 * Setup-only relaxation (`prim doctor --expect-backlog`). A reinstall or
 * re-auth can inherit Moves that already missed the 30s delivery SLA, and only
 * the daemon setup just started can drain them. When the daemon passes every
 * other daemon check (supervised, owned, current, authenticated, heartbeating)
 * and its delivery state is draining (see delivery-backlog.ts), its missed SLA
 * and the journal backlog are warnings instead of failures. Any such backlog
 * qualifies, however it arose. Organization buckets the daemon holds back,
 * and a failure it recorded without acknowledging anything first, still fail;
 * a failure it has not recorded yet (a sweep still in flight, or one that
 * bowed out to a concurrent drain) is not visible here. Standalone doctor
 * never sets it.
 */
export type DoctorOptions = { backlogExpected?: boolean };

export type MovesStatus = {
  captureState: "enabled" | "disabled";
  latestIngestAt: number | null;
  latestClassificationAt: number | null;
  highWaterMark: number | null;
  pendingSessionCount: number;
  sampled: boolean;
  oldestPendingAt?: number | null;
  oldestPendingAgeMs?: number | null;
  pendingCommitCorrelationCount?: number;
};

/**
 * Fold the per-check statuses into an overall verdict + process exit code.
 * Pure, so the exit-code contract is unit-pinned like daemon's classifyStatus:
 *   any fail -> unhealthy, exit 1
 *   any warn -> degraded, exit 0 (actionable, not broken)
 *   else     -> healthy, exit 0
 */
export function classifyDoctor(checks: Check[]): DoctorVerdict {
  const status: CheckStatus = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
      ? "warn"
      : "ok";
  return {
    json: { ok: status !== "fail", status, checks },
    exitCode: status === "fail" ? EXIT_UNHEALTHY : 0,
  };
}

export function classifyAuthCredential(
  credential: AuthCredential | undefined,
  expiresAt: number | undefined,
  hasRefresh: boolean,
): Check {
  if (!credential) {
    return { name: "auth", status: "fail", detail: "no token — run `prim auth login`" };
  }
  if (credential.source !== "token_file") {
    return { name: "auth", status: "ok", detail: "valid fixed bearer credential" };
  }
  if (expiresAt !== undefined && Date.now() >= expiresAt) {
    return hasRefresh
      ? { name: "auth", status: "warn", detail: "access token expired (refresh available)" }
      : {
          name: "auth",
          status: "fail",
          detail: "token expired, no refresh — run `prim auth login`",
        };
  }
  if (!hasRefresh) {
    return { name: "auth", status: "warn", detail: "no refresh token — capture stops at expiry" };
  }
  const detail =
    expiresAt !== undefined
      ? `valid (${String(Math.round((expiresAt - Date.now()) / MS_PER_SECOND))}s left)`
      : "valid";
  return { name: "auth", status: "ok", detail };
}

function checkAuth(): Check {
  const credential = resolveAuthCredential();
  const storedCredential = credential?.source === "token_file";
  return classifyAuthCredential(
    credential,
    storedCredential ? getTokenExpiresAt() : undefined,
    storedCredential && existsSync(REFRESH_TOKEN_PATH),
  );
}

export function classifyDaemonHealth(
  snapshot: DaemonDoctorSnapshot | null,
  options: {
    disabled?: boolean;
    service?: LaunchdService;
    ingestionStatus?: "enabled" | "disabled";
    expectedVersion?: string | null;
    /**
     * A live journal scan. The daemon refreshes its own pending count and age
     * only around its sweeps, so doctor reports the backlog from the same
     * scan its journal check reads.
     */
    backlog?: PendingBacklog;
    now?: number;
  } & DoctorOptions = {},
): Check {
  if (options.disabled) {
    return {
      name: "daemon",
      status: "fail",
      detail: "explicitly stopped — run `prim daemon start`",
    };
  }
  if (options.service && !options.service.loaded) {
    return {
      name: "daemon",
      status: "fail",
      detail: "launchd service is not loaded — run `prim daemon start`",
    };
  }
  if (!snapshot) {
    return {
      name: "daemon",
      status: "fail",
      detail: "socket unavailable — run `prim daemon start`",
    };
  }
  if (
    options.service &&
    (!Number.isInteger(options.service.pid) ||
      (options.service.pid ?? 0) <= 0 ||
      !Number.isInteger(snapshot.pid) ||
      (snapshot.pid ?? 0) <= 0 ||
      options.service.pid !== snapshot.pid)
  ) {
    return {
      name: "daemon",
      status: "fail",
      detail: `launchd does not own the daemon socket (launchd ${String(options.service.pid ?? "none")} · socket ${String(snapshot.pid ?? "none")})`,
    };
  }
  if (snapshot.envMismatch) {
    return {
      name: "daemon",
      status: "fail",
      detail: "daemon deployment differs from this CLI — run `prim daemon restart`",
    };
  }
  if (snapshot.principalMismatch) {
    return {
      name: "daemon",
      status: "fail",
      detail: "daemon credential or organization differs from this CLI — run `prim daemon restart`",
    };
  }
  if (options.expectedVersion === null) {
    return {
      name: "daemon",
      status: "fail",
      detail: "local Primitive package version is unavailable — reinstall the CLI",
    };
  }
  if (options.expectedVersion !== undefined) {
    const order = compareSemver(snapshot.version, options.expectedVersion);
    if (order === undefined) {
      return {
        name: "daemon",
        status: "fail",
        detail: "daemon version is unavailable or malformed — run `prim daemon restart`",
      };
    }
    if (snapshot.version !== options.expectedVersion) {
      const relation = order === 0 ? "different from" : order < 0 ? "older than" : "newer than";
      return {
        name: "daemon",
        status: "fail",
        detail: `daemon is ${relation} this CLI — run \`prim daemon restart\``,
      };
    }
  }
  if (snapshot.needsReauth) {
    // The daemon is supervised and its socket is up; it has deliberately halted
    // its loops because the session is terminally dead. Surface the one action
    // that recovers it instead of the opaque "heartbeat unhealthy — HTTP 500".
    return {
      name: "daemon",
      status: "fail",
      detail: "authentication ended — run `prim auth login`",
    };
  }
  if (!snapshot.heartbeat?.healthy) {
    return {
      name: "daemon",
      status: "fail",
      detail: `heartbeat unhealthy${snapshot.heartbeat?.lastError ? ` — ${snapshot.heartbeat.lastError}` : ""}`,
    };
  }
  if (!snapshot.ingestion?.healthy) {
    // Every check above passed, so this daemon is live, owned, current, and
    // authenticated, and it owns the drain. An expected backlog is reported;
    // held-back buckets and a failure recorded without progress still fail.
    if (options.backlogExpected && deliveryBacklogState(snapshot.ingestion) === "draining") {
      const ingestionStatus = options.ingestionStatus ?? decisionIngestionStatus(process.cwd());
      const live = options.backlog;
      // The live scan can find the queue empty before the daemon's next sweep
      // refreshes its own count; that backlog is drained, not "unknown".
      const progress =
        live && live.pendingCount === 0 && live.pendingSampled !== true
          ? "backlog drained; daemon health refreshes on its next sweep"
          : deliveryBacklogSummary(snapshot.ingestion, options.now, live);
      return {
        name: "daemon",
        status: "warn",
        detail: `supervised and live${snapshot.version ? ` · v${snapshot.version}` : ""} · Decision ingestion ${ingestionStatus} · ${progress}`,
      };
    }
    // Same scan as the journal check when one is supplied, so one doctor run
    // never shows two different pending counts.
    const counts = options.backlog ?? snapshot.ingestion;
    const pending = counts?.pendingCount ?? 0;
    const pendingLabel = counts?.pendingSampled ? `at least ${String(pending)}` : String(pending);
    return {
      name: "daemon",
      status: "fail",
      detail: `ingestion unhealthy · ${pendingLabel} pending${snapshot.ingestion?.lastError ? ` — ${snapshot.ingestion.lastError}` : ""}`,
    };
  }
  if (snapshot.healthy !== true) {
    return { name: "daemon", status: "fail", detail: "health state is not ready" };
  }
  const ingestionStatus = options.ingestionStatus ?? decisionIngestionStatus(process.cwd());
  return {
    name: "daemon",
    status: "ok",
    detail: `supervised and healthy${snapshot.version ? ` · v${snapshot.version}` : ""} · Decision ingestion ${ingestionStatus}`,
  };
}

/** The live inputs to the daemon, journal, and stranded checks. */
export type DeliveryProbe = {
  snapshot: DaemonDoctorSnapshot | null;
  /** Set when launchd could not be queried; then nothing else was probed. */
  launchdError?: string;
  service?: LaunchdService;
  disabled: boolean;
  expectedVersion: string | null;
  ingestionStatus?: "enabled" | "disabled";
  /** One journal scan per doctor run, shared by every check that reports it. */
  stats: PendingJournalStats;
  now: number;
};

async function probeDelivery(): Promise<DeliveryProbe> {
  const stats = pendingJournalStats();
  const now = Date.now();
  const disabled = daemonExplicitlyDisabled();
  const expectedVersion = packageVersion();
  let service: LaunchdService | undefined;
  if (process.platform === "darwin") {
    try {
      service = getLaunchdService();
    } catch (error) {
      return {
        snapshot: null,
        launchdError: error instanceof Error ? error.message : String(error),
        disabled,
        expectedVersion,
        stats,
        now,
      };
    }
  }
  const snapshot = await daemonRequest<DaemonDoctorSnapshot>(
    "status_snapshot",
    { callerEnv: getSiteUrl() },
    { timeoutMs: DAEMON_PROBE_TIMEOUT_MS },
  );
  return { snapshot, service, disabled, expectedVersion, stats, now };
}

/**
 * Whether a daemon check vouches for a background drain: it passed outright,
 * or it is setup's expected-backlog warning. classifyDaemonHealth fails every
 * other state, and then nothing is known to be draining the journal.
 */
function daemonCheckVouchesForDrain(check: Check): boolean {
  return check.name === "daemon" && check.status !== "fail";
}

/** The daemon, journal, and stranded checks, in display order. */
export function classifyDelivery(probe: DeliveryProbe, options: DoctorOptions = {}): Check[] {
  const { stats, now } = probe;
  const launchdDetail =
    probe.launchdError === undefined ? undefined : boundedHealthError(probe.launchdError);
  const daemon: Check =
    probe.launchdError === undefined
      ? classifyDaemonHealth(probe.snapshot, {
          disabled: probe.disabled,
          service: probe.service,
          ingestionStatus: probe.ingestionStatus,
          expectedVersion: probe.expectedVersion,
          backlogExpected: options.backlogExpected,
          backlog: {
            pendingCount: stats.pendingCount,
            pendingSampled: stats.sampled,
            oldestPendingAt: stats.oldestPendingAt,
          },
          now,
        })
      : {
          name: "daemon",
          status: "fail",
          detail: `launchd status unavailable${launchdDetail ? `: ${launchdDetail}` : ""}`,
        };
  // The journal backlog may be relaxed only while a vouched-for daemon owns
  // its drain; next to a failed daemon check it is an undelivered queue.
  const journal = classifyJournal(stats, now, {
    backlogExpected: options.backlogExpected === true && daemonCheckVouchesForDrain(daemon),
  });
  return [daemon, journal, classifyStranded(stats)];
}

export function classifyJournal(
  stats: PendingJournalStats,
  now: number,
  options: DoctorOptions = {},
): Check {
  const pending = stats.pendingCount;
  const pendingLabel = stats.sampled ? `at least ${String(pending)}` : String(pending);
  // Size and age are the backlog conditions an expected backlog may relax;
  // the daemon check independently proves something is draining it.
  const backlog = (detail: string): Check =>
    options.backlogExpected
      ? {
          name: "journal",
          status: "warn",
          detail: `${formatPendingBacklog(
            {
              pendingCount: pending,
              pendingSampled: stats.sampled,
              oldestPendingAt: stats.oldestPendingAt,
            },
            now,
          )} — draining in the background`,
        }
      : { name: "journal", status: "fail", detail };
  if (pending === 0) {
    if (stats.sampled) {
      return backlog("bounded journal sample could not prove the queue is empty");
    }
    return { name: "journal", status: "ok", detail: "no pending moves" };
  }
  if (stats.oldestPendingAt === undefined) {
    const detail = `${pendingLabel} pending with no readable capture timestamp`;
    // Only a bounded sample can hide every timestamp; a fully read queue
    // without one is unreadable, not merely behind, and stays a failure.
    return stats.sampled ? backlog(detail) : { name: "journal", status: "fail", detail };
  }
  const oldestMs = now - stats.oldestPendingAt;
  const oldestS = Math.round(oldestMs / MS_PER_SECOND);
  if (oldestMs > STALE_PENDING_MS) {
    return backlog(
      `${pendingLabel} pending, oldest observed ${String(oldestS)}s — 30s delivery SLA missed`,
    );
  }
  if (stats.sampled) {
    return backlog(`${pendingLabel} pending in bounded sample; 30s delivery SLA cannot be proven`);
  }
  return { name: "journal", status: "ok", detail: `${String(pending)} pending, draining` };
}

export function classifyStranded(stats: PendingJournalStats): Check {
  if (stats.strandedFileCount === 0 && !stats.strandedSampled) {
    return { name: "stranded", status: "ok", detail: "none" };
  }
  const qualifier = stats.strandedSampled ? "at least " : "";
  return {
    name: "stranded",
    status: "warn",
    detail: `${qualifier}${String(stats.strandedCount)} move(s) in ${qualifier}${String(stats.strandedFileCount)} file(s) — run \`prim moves flush\``,
  };
}

export function classifyJournalOrganization(
  bucketCount: number,
  retainedBuckets: RetainedJournalBucket[],
): Check {
  if (bucketCount === 0) {
    return {
      name: "journal-org",
      status: "ok",
      detail: "no pending organization buckets",
    };
  }
  if (retainedBuckets.length === 0) {
    return {
      name: "journal-org",
      status: "ok",
      detail: "all pending buckets match the active credential",
    };
  }
  return {
    name: "journal-org",
    status: "fail",
    detail: `${String(retainedBuckets.length)} bucket(s) retained (${summarizeRetainedBuckets(retainedBuckets)})`,
  };
}

async function checkJournalOrganization(): Promise<Check> {
  const buckets = [
    ...listBuckets().map((entry) => entry.bucket),
    ...listFlushing({ sampleBytes: 0 }).map((entry) => entry.bucket),
  ];
  if (buckets.length === 0) {
    return classifyJournalOrganization(0, []);
  }
  const inspection = await inspectJournalDelivery(buckets);
  return classifyJournalOrganization(new Set(buckets).size, inspection.retainedBuckets);
}

export function classifyRepositoryBinding(
  value: string | undefined,
  current: RepositoryBindingResult,
  active: boolean,
): Check {
  const connectionCapabilities =
    "It enables repository-specific file attribution, Conflict Gate verification, and commit correlation.";
  if (current.status === "unbound") {
    if (!active) {
      return {
        name: "github-repo-connection",
        status: "fail",
        detail: `GitHub repo connection is required before using Primitive in this repository. ${connectionCapabilities} Run \`prim github connect\`, then \`prim enable\`.`,
      };
    }
    const localDetail =
      value === undefined
        ? "GitHub repo connection is not complete"
        : isValidRepoSyncId(value)
          ? "server reports GitHub repo connection is not complete; the last connection state is retained locally for recovery"
          : "server reports GitHub repo connection is not complete; the local cached connection state is invalid";
    return {
      name: "github-repo-connection",
      status: "warn",
      detail: `${localDetail} — GitHub repo connection is required before using Primitive in this repository. ${connectionCapabilities} Run \`prim github connect\` to complete it.`,
    };
  }
  if (!isValidRepoSyncId(value)) {
    return {
      name: "github-repo-connection",
      status: "fail",
      detail: `GitHub repo connection state is missing or invalid. ${connectionCapabilities} Run \`prim github connect\`, then \`prim enable\`.`,
    };
  }
  if (value !== current.repoSyncId) {
    return {
      name: "github-repo-connection",
      status: "fail",
      detail: `GitHub repo connection is stale for the current origin. ${connectionCapabilities} Run \`prim github connect\`, then \`prim enable\`.`,
    };
  }
  return {
    name: "github-repo-connection",
    status: "ok",
    detail: `GitHub repo connection is verified. ${connectionCapabilities}`,
  };
}

export async function checkRepositoryBinding(): Promise<Check> {
  const root = process.cwd();
  const local = repoSyncId(root);
  try {
    const current = await resolveRepositoryBinding(root, {
      signal: AbortSignal.timeout(CONNECTIVITY_TIMEOUT_MS),
      quietRefresh: true,
    });
    return classifyRepositoryBinding(local, current, isRepoActiveForCapture(root));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const detail =
      boundedHealthError(`could not verify the current GitHub repo connection — ${message}`) ??
      "could not verify the current GitHub repo connection";
    return {
      name: "github-repo-connection",
      status: "fail",
      detail,
    };
  }
}

// The command that repairs an uncovered hook, by reason and by where the hook
// lives. Doctor itself never writes: it only reports and names the remedy.
function managedHookRemedy(inspection: ManagedHookInspection): string | undefined {
  switch (inspection.reason) {
    case "missing":
    case "missing_block":
    case "stale_block":
    case "legacy_block":
    case "unreachable_block":
    case "misplaced_block":
      if (inspection.location === "prim") return "run `prim enable` to refresh prim's global hooks";
      if (inspection.location === "external") {
        return `outside this repository — ${externalHookRemedy(inspection.hookName, inspection.gitRoot)}`;
      }
      return "run `prim hooks install`";
    case "entrypoint_missing":
      return "run `prim enable` to stage the hook runtime";
    default:
      return undefined;
  }
}

export function classifyManagedHook(
  hookName: ManagedGitHookName,
  inspection: ManagedHookInspection,
  firing?: PostCommitFiring,
): Check {
  if (inspection.covered) {
    return {
      name: hookName,
      status: "ok",
      detail: `effective and executable · ${inspection.kind} · ${inspection.hookPath}`,
    };
  }
  const reason = inspection.reason ?? "uncovered";
  // Manual mode is the user's choice, not a fault: report what prim found
  // without failing. pre-commit is a warn-only check, so it never fails doctor.
  if (inspection.mode === "manual") {
    // The user's own wiring is invisible to file inspection; a run for the
    // latest commit proves it.
    if (hookName === "post-commit" && firing?.state === "fired") {
      return {
        name: hookName,
        status: "ok",
        detail: `manual (prim.gitHooks=manual) · ran for the latest commit · ${inspection.hookPath}`,
      };
    }
    return {
      name: hookName,
      status: "warn",
      detail: `manual (prim.gitHooks=manual) · ${reason} · wire with \`prim hooks snippet ${hookName}\` · ${inspection.hookPath}`,
    };
  }
  const remedy = managedHookRemedy(inspection);
  // Capture still works in exactly two cases: a recognized pre-v1 block that is
  // reachable and executable, and a block that runs twice (above husky.sh).
  // The inspection reports either only after every real failure is ruled out.
  const stillCaptures = reason === "legacy_block" || reason === "misplaced_block";
  return {
    name: hookName,
    status: hookName === "pre-commit" || stillCaptures ? "warn" : "fail",
    detail: `${reason}${remedy ? ` · ${remedy}` : ""} · ${inspection.hookPath}`,
  };
}

export function classifyPostCommitHook(inspection: ManagedHookInspection): Check {
  return classifyManagedHook("post-commit", inspection);
}

function minutesAgo(at: number, now: number): string {
  const minutes = Math.max(0, Math.round((now - at) / 60_000));
  return minutes === 0 ? "just now" : `${String(minutes)}m ago`;
}

/**
 * Whether post-commit reached prim for the latest local commit. A hook that
 * looks wired but never runs (an `exit` the heuristic missed, a GUI client
 * without prim's environment) fails here even when every file looks right.
 */
export function classifyHookFiring(firing: PostCommitFiring, now: number = Date.now()): Check {
  const name = "hook-fired";
  switch (firing.state) {
    case "inactive":
      return { name, status: "ok", detail: "repository not active — no post-commit run expected" };
    case "unverified":
      return {
        name,
        status: "ok",
        detail: "no local commit since the hooks were wired — the next commit is checked",
      };
    case "pending":
      return {
        name,
        status: "ok",
        detail: `latest commit is under ${String(POST_COMMIT_GRACE_MS / 1_000)}s old — capture may still be starting`,
      };
    case "fired":
      return {
        name,
        status: "ok",
        detail: `post-commit reached prim for the latest commit (${minutesAgo(firing.firedAt, now)})`,
      };
    case "not_firing":
      return {
        name,
        status: "fail",
        detail: `post-commit never reached prim for the commit made ${minutesAgo(firing.commitAt, now)}${
          firing.firedAt === undefined ? "" : ` (last run ${minutesAgo(firing.firedAt, now)})`
        } · likely an exit/exec before prim's block, hooks turned off for that commit (HUSKY=0, a core.hooksPath override), or a git client without prim's environment · fix the cause, then commit to re-check · if prim was off for that commit (set with \`git config prim.active\` directly), run \`prim disable\` then \`prim enable\` to restart the check`,
      };
  }
}

function inspectFiringHere(): PostCommitFiring | undefined {
  try {
    const root = gitToplevel();
    return root ? inspectPostCommitFiring(root) : undefined;
  } catch {
    return undefined;
  }
}

function checkHookFiring(firing: PostCommitFiring | undefined): Check {
  return firing
    ? classifyHookFiring(firing)
    : { name: "hook-fired", status: "warn", detail: "not a git repository" };
}

function checkManagedHook(hookName: ManagedGitHookName, firing?: PostCommitFiring): Check {
  try {
    return classifyManagedHook(hookName, inspectEffectiveGitHook(hookName), firing);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      name: hookName,
      status: /not a git repository/iu.test(detail) ? "warn" : "fail",
      detail: detail.slice(0, 120),
    };
  }
}

function checkFeedbackHooks(): Check {
  try {
    const status = claudeStatus();
    return classifyClaudeHooks([status.project, status.user]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "feedback-hooks", status: "warn", detail: message.slice(0, 80) };
  }
}

type AgentHookSurface = Readonly<{
  present: boolean;
  gate: boolean;
  capture: boolean;
  complete: boolean;
}>;

export function classifyClaudeHooks(statuses: readonly AgentHookSurface[]): Check {
  const installed = statuses.filter((status) => status.present);
  if (installed.length === 0) {
    return {
      name: "feedback-hooks",
      status: "warn",
      detail: "Claude lifecycle hooks missing — run `prim claude install`",
    };
  }
  if (installed.some((status) => !status.complete)) {
    return {
      name: "feedback-hooks",
      status: "fail",
      detail: "incomplete or drifted Claude lifecycle — run `prim claude install --force`",
    };
  }
  return { name: "feedback-hooks", status: "ok", detail: "complete Claude lifecycle ready" };
}

export function classifyCodexHooks(
  statuses: readonly AgentHookSurface[],
  uncoveredWorktree: string | null = null,
): Check {
  const installed = statuses.filter((status) => status.present);
  if (installed.length === 0) {
    if (uncoveredWorktree !== null) {
      return {
        name: "codex-hooks",
        status: "warn",
        detail: uncoveredWorktreeAdvice(uncoveredWorktree),
      };
    }
    return { name: "codex-hooks", status: "ok", detail: "not installed" };
  }
  if (installed.some((status) => !status.complete)) {
    return {
      name: "codex-hooks",
      status: "fail",
      detail: "incomplete or drifted hook lifecycle — run `prim codex install --force`",
    };
  }
  return {
    name: "codex-hooks",
    status: "warn",
    detail: "installed; Codex trust is not machine-readable — verify with `/hooks`",
  };
}

export function classifyCursorHooks(
  statuses: readonly (AgentHookSurface & {
    footer?: boolean;
    footerPreservedCustom?: boolean;
  })[],
): Check {
  const installed = statuses.filter((status) => status.present);
  if (installed.length === 0)
    return { name: "cursor-hooks", status: "ok", detail: "not installed" };
  if (installed.some((status) => !status.complete)) {
    return {
      name: "cursor-hooks",
      status: "fail",
      detail: "incomplete or drifted native lifecycle — run `prim cursor install --force`",
    };
  }
  const user = statuses.find((status) => status.footer !== undefined);
  if (user?.present && user.footer === false && !user.footerPreservedCustom) {
    return {
      name: "cursor-hooks",
      status: "fail",
      detail:
        "native lifecycle ready but Cursor CLI footer is missing — run `prim cursor install --scope user --force`",
    };
  }
  if (statuses.some((status) => status.footerPreservedCustom)) {
    return {
      name: "cursor-hooks",
      status: "warn",
      detail: "native lifecycle ready; custom Cursor CLI footer preserved",
    };
  }
  return { name: "cursor-hooks", status: "ok", detail: "complete native lifecycle ready" };
}

export function classifyHermesHooks(status: AgentHookSurface & { autoAccept: boolean }): Check {
  if (!status.present) {
    return { name: "hermes-hooks", status: "ok", detail: "not installed" };
  }
  if (!status.complete) {
    return {
      name: "hermes-hooks",
      status: "fail",
      detail: "incomplete or drifted hook lifecycle — run `prim hermes install --force`",
    };
  }
  return status.autoAccept
    ? { name: "hermes-hooks", status: "ok", detail: "installed and pre-authorized" }
    : {
        name: "hermes-hooks",
        status: "warn",
        detail:
          "installed; hook consent is not pre-authorized — run `prim hermes install --auto-accept`",
      };
}

function checkAgentHooks(): Check[] {
  const checks: Check[] = [];
  try {
    const status = codexStatus();
    checks.push(classifyCodexHooks([status.project, status.user], uncoveredWorktreeHooks(status)));
  } catch (error) {
    const detail = boundedHealthError(error instanceof Error ? error.message : String(error));
    checks.push({
      name: "codex-hooks",
      status: "fail",
      detail: detail ?? "hook configuration is unreadable",
    });
  }
  try {
    const status = cursorStatus();
    checks.push(classifyCursorHooks([status.project, status.user]));
  } catch (error) {
    const detail = boundedHealthError(error instanceof Error ? error.message : String(error));
    checks.push({
      name: "cursor-hooks",
      status: "fail",
      detail: detail ?? "hook configuration is unreadable",
    });
  }
  try {
    checks.push(classifyHermesHooks(hermesStatus()));
  } catch (error) {
    const detail = boundedHealthError(error instanceof Error ? error.message : String(error));
    checks.push({
      name: "hermes-hooks",
      status: "fail",
      detail: detail ?? "hook configuration is unreadable",
    });
  }
  return checks;
}

export function classifyHookRuntime(
  inspection: HookRuntimeInspection,
  expectedVersion: string | null,
): Check {
  if (expectedVersion === null) {
    return {
      name: "hook-runtime",
      status: "fail",
      detail: "local Primitive package version is unavailable — reinstall the CLI",
    };
  }
  if (inspection.state !== "ready") {
    const condition = inspection.state === "missing" ? "missing" : "invalid";
    return {
      name: "hook-runtime",
      status: "fail",
      detail:
        inspection.state === "missing"
          ? `immutable runtime ${condition}; stable hooks have no npx fallback — reinstall an agent integration`
          : "immutable runtime is invalid; remove or repair it before reinstalling an agent integration",
    };
  }
  const order = compareSemver(inspection.version, expectedVersion);
  if (order === undefined || inspection.version !== expectedVersion) {
    if (order !== undefined && order > 0) {
      return {
        name: "hook-runtime",
        status: "fail",
        detail: `selected immutable runtime is newer than this CLI — upgrade this CLI to v${inspection.version} or use a matching CLI; it will not be downgraded automatically`,
      };
    }
    const relation = order !== undefined && order < 0 ? "is older than" : "differs from";
    return {
      name: "hook-runtime",
      status: "fail",
      detail: `selected immutable runtime ${relation} this CLI — reinstall an agent integration`,
    };
  }
  return {
    name: "hook-runtime",
    status: "ok",
    detail: `immutable runtime ready · v${inspection.version}`,
  };
}

function classifyExactNpxFallback(
  resolutions: readonly HookCommandResolution[],
  expectedVersion: string,
): Check {
  const pinnedVersions = [
    ...new Set(
      resolutions.flatMap((resolution) =>
        resolution.kind === "exact_npx_fallback" ? [resolution.version] : [],
      ),
    ),
  ];
  if (pinnedVersions.length !== 1 || pinnedVersions[0] !== expectedVersion) {
    return {
      name: "hook-runtime",
      status: "fail",
      detail:
        "registered exact npx fallback does not match this CLI — reinstall an agent integration",
    };
  }
  return {
    name: "hook-runtime",
    status: "fail",
    detail:
      "registered exact npx fallback cannot be safely verified without executing it — reinstall an agent integration",
  };
}

export function diagnoseRegisteredHookRuntime(
  resolutions: readonly HookCommandResolution[],
  inspectRuntime: () => HookRuntimeInspection,
  expectedVersion: () => string | null,
): Check {
  if (resolutions.length === 0) {
    return {
      name: "hook-runtime",
      status: "ok",
      detail: "not required: no Primitive hook registrations",
    };
  }
  if (resolutions.some((resolution) => resolution.kind === "legacy_path")) {
    return {
      name: "hook-runtime",
      status: "fail",
      detail: "legacy PATH hook cannot be verified — reinstall an agent integration",
    };
  }

  const version = expectedVersion();
  if (version === null) {
    return {
      name: "hook-runtime",
      status: "fail",
      detail: "local Primitive package version is unavailable — reinstall the CLI",
    };
  }
  const stableCheck = resolutions.some((resolution) => resolution.kind === "stable_launcher")
    ? classifyHookRuntime(inspectRuntime(), version)
    : undefined;
  const npxCheck = resolutions.some((resolution) => resolution.kind === "exact_npx_fallback")
    ? classifyExactNpxFallback(resolutions, version)
    : undefined;
  if (stableCheck?.status === "fail") return stableCheck;
  if (npxCheck) return npxCheck;
  if (stableCheck) return stableCheck;
  return {
    name: "hook-runtime",
    status: "fail",
    detail: "hook runtime registration is unrecognized — reinstall an agent integration",
  };
}

function checkHookRuntime(): Check {
  try {
    return diagnoseRegisteredHookRuntime(
      [
        ...claudeHookRuntimeResolutions(),
        ...codexHookRuntimeResolutions(),
        ...cursorHookRuntimeResolutions(),
        ...hermesHookRuntimeResolutions(),
      ],
      inspectHookRuntime,
      packageVersion,
    );
  } catch (error) {
    const detail = boundedHealthError(error instanceof Error ? error.message : String(error));
    return {
      name: "hook-runtime",
      status: "fail",
      detail: detail ?? "hook configuration is unreadable",
    };
  }
}

function parseMovesStatus(value: unknown): MovesStatus {
  if (!value || typeof value !== "object") {
    throw new Error("moves status returned a non-object response");
  }
  const status = value as Partial<MovesStatus>;
  const nullableNumber = (candidate: unknown): boolean =>
    candidate === null || (typeof candidate === "number" && Number.isFinite(candidate));
  if (
    (status.captureState !== "enabled" && status.captureState !== "disabled") ||
    !nullableNumber(status.latestIngestAt) ||
    !nullableNumber(status.latestClassificationAt) ||
    !nullableNumber(status.highWaterMark) ||
    typeof status.pendingSessionCount !== "number" ||
    !Number.isInteger(status.pendingSessionCount) ||
    status.pendingSessionCount < 0 ||
    typeof status.sampled !== "boolean"
  ) {
    throw new Error("moves status returned an invalid response");
  }
  if (
    (status.oldestPendingAt !== undefined && !nullableNumber(status.oldestPendingAt)) ||
    (status.oldestPendingAgeMs !== undefined && !nullableNumber(status.oldestPendingAgeMs)) ||
    (typeof status.oldestPendingAgeMs === "number" && status.oldestPendingAgeMs < 0) ||
    (status.pendingCommitCorrelationCount !== undefined &&
      (!Number.isInteger(status.pendingCommitCorrelationCount) ||
        status.pendingCommitCorrelationCount < 0))
  ) {
    throw new Error("moves status returned invalid pending-age fields");
  }
  return status as MovesStatus;
}

export function classifyMovesStatus(status: MovesStatus): Check[] {
  const capture: Check =
    status.captureState === "enabled"
      ? { name: "capture", status: "ok", detail: "enabled; ingest endpoint durable" }
      : {
          name: "capture",
          status: "fail",
          detail: "disabled for the current organization; local Moves are retained",
        };
  const correlation: Check | undefined =
    status.pendingCommitCorrelationCount === undefined
      ? undefined
      : status.pendingCommitCorrelationCount > 0
        ? {
            name: "commit-correlation",
            status: "warn",
            detail: `${String(status.pendingCommitCorrelationCount)} commit(s) awaiting evidence correlation`,
          }
        : {
            name: "commit-correlation",
            status: "ok",
            detail: "caught up",
          };
  return correlation ? [capture, correlation] : [capture];
}

async function checkBackend(): Promise<Check[]> {
  try {
    // Bypass the daemon so this independently verifies server reachability,
    // auth, capture entitlement, and commit-correlation status.
    const response = await getClient().get("/api/cli/moves/status", {
      signal: AbortSignal.timeout(CONNECTIVITY_TIMEOUT_MS),
    });
    const status = parseMovesStatus(response);
    return [
      { name: "connectivity", status: "ok", detail: "server reachable and authenticated" },
      ...classifyMovesStatus(status),
    ];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return [{ name: "connectivity", status: "fail", detail: message.slice(0, 120) }];
  }
}

async function checkFeedbackCapability(): Promise<Check> {
  try {
    const capability = await fetchFeedbackCapability(AbortSignal.timeout(CONNECTIVITY_TIMEOUT_MS));
    return capability.status === "available"
      ? { name: "feedback-api", status: "ok", detail: "server supports decision feedback" }
      : {
          name: "feedback-api",
          status: "warn",
          detail: "available after binding this CLI to an organization",
        };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return {
        name: "feedback-api",
        status: "warn",
        detail: "server does not support decision feedback yet",
      };
    }
    if (error instanceof HttpError && error.status === 401) {
      return { name: "feedback-api", status: "fail", detail: error.message.slice(0, 80) };
    }
    const message = error instanceof Error ? error.message : String(error);
    return { name: "feedback-api", status: "warn", detail: message.slice(0, 80) };
  }
}

/**
 * The probes behind doctor's checks. Only the delivery checks depend on
 * DoctorOptions; the rest are grouped around them in display order.
 */
export type DoctorProbes = {
  delivery: () => Promise<DeliveryProbe>;
  independent: () => Promise<{ before: Check[]; after: Check[] }>;
};

async function independentChecks(): Promise<{ before: Check[]; after: Check[] }> {
  const backend = await checkBackend();
  const firing = inspectFiringHere();
  return {
    before: [checkAuth()],
    after: [
      await checkJournalOrganization(),
      checkFeedbackHooks(),
      ...checkAgentHooks(),
      checkHookRuntime(),
      await checkRepositoryBinding(),
      checkManagedHook("pre-commit"),
      checkManagedHook("post-commit", firing),
      checkManagedHook("post-rewrite"),
      checkHookFiring(firing),
      ...backend,
      await checkFeedbackCapability(),
    ],
  };
}

const DEFAULT_DOCTOR_PROBES: DoctorProbes = {
  delivery: probeDelivery,
  independent: independentChecks,
};

async function collectChecks(options: DoctorOptions, probes: DoctorProbes): Promise<Check[]> {
  const { before, after } = await probes.independent();
  return [...before, ...classifyDelivery(await probes.delivery(), options), ...after];
}

function icon(status: CheckStatus): string {
  return status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
}

async function runDoctor(options: DoctorOptions, probes: DoctorProbes): Promise<void> {
  const checks = await collectChecks(options, probes);
  const { json, exitCode } = classifyDoctor(checks);

  const headline =
    json.status === "ok" ? "✓ healthy" : json.status === "warn" ? "⚠ degraded" : "✗ unhealthy";
  process.stderr.write(`[prim] doctor: ${headline}\n`);
  for (const c of checks) {
    process.stderr.write(`  ${icon(c.status)} ${c.name.padEnd(13)} ${c.detail}\n`);
  }

  console.log(JSON.stringify(json, null, 2));
  if (exitCode !== 0 && !process.exitCode) {
    process.exitCode = exitCode;
  }
}

export function registerDoctorCommands(
  program: Command,
  dependencies: { probes?: DoctorProbes } = {},
): void {
  program
    .command("doctor")
    .description(
      "Check capture and feedback health end to end (auth, supervisor, delivery, server)",
    )
    // Passed only by `prim setup`; see DoctorOptions.
    .addOption(new Option("--expect-backlog").hideHelp())
    .action(async (opts: { expectBacklog?: boolean }) => {
      await runDoctor(
        { backlogExpected: opts.expectBacklog === true },
        dependencies.probes ?? DEFAULT_DOCTOR_PROBES,
      );
    });
}
