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
import type { Command } from "commander";
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
import { type RetainedJournalBucket, inspectJournalDelivery } from "../journal-organization.js";
import { listBuckets, listFlushing, pendingJournalStats } from "../journal.js";
import {
  decisionIngestionStatus,
  isRepoActiveForCapture,
  isValidRepoSyncId,
  repoSyncId,
} from "../lib/activation.js";
import { boundedHealthError } from "../lib/ansi.js";
import { type HookCommandResolution, packageVersion } from "../lib/bin-path.js";
import { type HookRuntimeInspection, inspectHookRuntime } from "../lib/hook-runtime.js";
import {
  type ManagedHookInspection,
  inspectEffectivePostCommitHook,
  inspectEffectivePostRewriteHook,
} from "../lib/post-commit-hook.js";
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
} from "./codex-install.js";
import {
  inspectHookRuntimeResolutions as hermesHookRuntimeResolutions,
  performStatus as hermesStatus,
} from "./hermes-install.js";
import { refreshOwnedGlobalHooks } from "./hooks.js";

const DAEMON_PROBE_TIMEOUT_MS = 500;
const CONNECTIVITY_TIMEOUT_MS = 3_000;
const MS_PER_SECOND = 1000;
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
  } = {},
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
    const pending = snapshot.ingestion?.pendingCount ?? 0;
    const pendingLabel = snapshot.ingestion?.pendingSampled
      ? `at least ${String(pending)}`
      : String(pending);
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

async function checkDaemon(): Promise<Check> {
  let service: LaunchdService | undefined;
  if (process.platform === "darwin") {
    try {
      service = getLaunchdService();
    } catch (error) {
      const detail = boundedHealthError(error instanceof Error ? error.message : String(error));
      return {
        name: "daemon",
        status: "fail",
        detail: `launchd status unavailable${detail ? `: ${detail}` : ""}`,
      };
    }
  }
  const snapshot = await daemonRequest<DaemonDoctorSnapshot>(
    "status_snapshot",
    { callerEnv: getSiteUrl() },
    { timeoutMs: DAEMON_PROBE_TIMEOUT_MS },
  );
  return classifyDaemonHealth(snapshot, {
    disabled: daemonExplicitlyDisabled(),
    service,
    expectedVersion: packageVersion(),
  });
}

function checkJournal(): Check {
  const stats = pendingJournalStats();
  const pending = stats.pendingCount;
  const pendingLabel = stats.sampled ? `at least ${String(pending)}` : String(pending);
  if (pending === 0) {
    if (stats.sampled) {
      return {
        name: "journal",
        status: "fail",
        detail: "bounded journal sample could not prove the queue is empty",
      };
    }
    return { name: "journal", status: "ok", detail: "no pending moves" };
  }
  if (stats.oldestPendingAt === undefined) {
    return {
      name: "journal",
      status: "fail",
      detail: `${pendingLabel} pending with no readable capture timestamp`,
    };
  }
  const oldestMs = Date.now() - stats.oldestPendingAt;
  const oldestS = Math.round(oldestMs / MS_PER_SECOND);
  if (oldestMs > STALE_PENDING_MS) {
    return {
      name: "journal",
      status: "fail",
      detail: `${pendingLabel} pending, oldest observed ${String(oldestS)}s — 30s delivery SLA missed`,
    };
  }
  if (stats.sampled) {
    return {
      name: "journal",
      status: "fail",
      detail: `${pendingLabel} pending in bounded sample; 30s delivery SLA cannot be proven`,
    };
  }
  return { name: "journal", status: "ok", detail: `${String(pending)} pending, draining` };
}

function checkStranded(): Check {
  const stats = pendingJournalStats();
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
  const reasonCounts = new Map<string, number>();
  for (const item of retainedBuckets) {
    reasonCounts.set(item.reason, (reasonCounts.get(item.reason) ?? 0) + 1);
  }
  const reasons = [...reasonCounts]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([reason, count]) => `${reason}:${String(count)}`)
    .join(", ");
  return {
    name: "journal-org",
    status: "fail",
    detail: `${String(retainedBuckets.length)} bucket(s) retained (${reasons})`,
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
  if (current.status === "unbound") {
    if (!active) {
      return {
        name: "repo-binding",
        status: "fail",
        detail: "passive capture is inactive — run `prim enable`",
      };
    }
    const localDetail =
      value === undefined
        ? "repository is unbound"
        : isValidRepoSyncId(value)
          ? "server reports this repository unbound; the last binding is retained locally for recovery"
          : "server reports this repository unbound; the local cached binding is invalid";
    return {
      name: "repo-binding",
      status: "warn",
      detail: `${localDetail} — local capture is active; run \`prim github connect\` to connect this GitHub repository`,
    };
  }
  if (!isValidRepoSyncId(value)) {
    return {
      name: "repo-binding",
      status: "fail",
      detail: "missing or invalid local prim.repoSyncId — run `prim enable`",
    };
  }
  if (value !== current.repoSyncId) {
    return {
      name: "repo-binding",
      status: "fail",
      detail: "local repository binding is stale for the current origin — run `prim enable`",
    };
  }
  return {
    name: "repo-binding",
    status: "ok",
    detail: "local repository binding matches the current server binding",
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
      boundedHealthError(`could not verify the current repository binding — ${message}`) ??
      "could not verify the current repository binding";
    return {
      name: "repo-binding",
      status: "fail",
      detail,
    };
  }
}

export function classifyManagedHook(
  hookName: "post-commit" | "post-rewrite",
  inspection: ManagedHookInspection,
): Check {
  if (inspection.covered) {
    return {
      name: hookName,
      status: "ok",
      detail: `effective and executable · ${inspection.kind} · ${inspection.hookPath}`,
    };
  }
  return {
    name: hookName,
    status: "fail",
    detail: `${inspection.reason ?? "uncovered"} · ${inspection.hookPath}`,
  };
}

export function classifyPostCommitHook(inspection: ManagedHookInspection): Check {
  return classifyManagedHook("post-commit", inspection);
}

function checkManagedHook(
  hookName: "post-commit" | "post-rewrite",
  inspect: () => ManagedHookInspection,
): Check {
  try {
    return classifyManagedHook(hookName, inspect());
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

export function classifyCodexHooks(statuses: readonly AgentHookSurface[]): Check {
  const installed = statuses.filter((status) => status.present);
  if (installed.length === 0) {
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
    checks.push(classifyCodexHooks([status.project, status.user]));
  } catch (error) {
    const detail = boundedHealthError(error instanceof Error ? error.message : String(error));
    checks.push({
      name: "codex-hooks",
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
 * Repair stale Prim-owned global hooks before checking their effective coverage.
 * A failed repair is intentionally ignored here so the inspection below can
 * report the underlying hook problem to the user.
 */
export function refreshOwnedGlobalHooksForHealth(): void {
  try {
    refreshOwnedGlobalHooks();
  } catch {
    // The managed-hook checks below retain the diagnostic when repair fails.
  }
}

async function collectChecks(): Promise<Check[]> {
  refreshOwnedGlobalHooksForHealth();
  const backend = await checkBackend();
  return [
    checkAuth(),
    await checkDaemon(),
    checkJournal(),
    checkStranded(),
    await checkJournalOrganization(),
    checkFeedbackHooks(),
    ...checkAgentHooks(),
    checkHookRuntime(),
    await checkRepositoryBinding(),
    checkManagedHook("post-commit", inspectEffectivePostCommitHook),
    checkManagedHook("post-rewrite", inspectEffectivePostRewriteHook),
    ...backend,
    await checkFeedbackCapability(),
  ];
}

function icon(status: CheckStatus): string {
  return status === "ok" ? "✓" : status === "warn" ? "⚠" : "✗";
}

async function runDoctor(): Promise<void> {
  const checks = await collectChecks();
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

export function registerDoctorCommands(program: Command): void {
  program
    .command("doctor")
    .description(
      "Check capture and feedback health end to end (auth, supervisor, delivery, server)",
    )
    .action(async () => {
      await runDoctor();
    });
}
