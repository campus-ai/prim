/**
 * `prim doctor` — one-shot capture-pipeline health check.
 *
 * Answers "is decision capture actually working, end to end?" in a single
 * command, instead of forcing an operator to correlate `auth status`,
 * `daemon status`, `moves status`, and a filesystem listing by hand (the
 * ~20-minute archaeology the user study turned into). Checks auth, supervised
 * daemon health, durable queue age, stranded rotations, capture entitlement,
 * classifier progress, worktree identity, and decision-feedback readiness,
 * then renders them
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
import { readHookMode } from "../hooks/pre-tool-use-scoring.js";
import { pendingJournalStats } from "../journal.js";
import { decisionIngestionStatus } from "../lib/activation.js";
import { resolveRepositoryContext } from "../lib/git.js";
import { inspectWorkspaceId } from "../lib/workspace-id.js";
import { performStatus as claudeStatus } from "./claude-install.js";
import { performStatus as codexStatus } from "./codex-install.js";
import { performStatus as hermesStatus } from "./hermes-install.js";

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
};

export type EnforcementReadiness = {
  captureEnabled: boolean;
  captureEntitlementState?: string;
  captureEntitlementSource?: "jwt" | "live" | "service_token";
  enforcementEnabled: boolean;
  enforcementEntitlementState?: string;
  entitlementSource?: "jwt" | "live" | "service_token";
  fileScopedDecisionCount: number;
  fileScopedDecisionCountTruncated?: boolean;
  lastPreflightAt: number | null;
  lastPreflightVerdict?: "allow" | "warn" | "ask" | "unavailable";
  lastPreflightReasonCode?: string;
  protocolVersion?: number;
  bypassActive?: boolean;
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
    } catch {
      service = { loaded: false };
    }
  }
  const snapshot = await daemonRequest<DaemonDoctorSnapshot>(
    "status_snapshot",
    {},
    { timeoutMs: DAEMON_PROBE_TIMEOUT_MS },
  );
  return classifyDaemonHealth(snapshot, {
    disabled: daemonExplicitlyDisabled(),
    service,
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

function checkWorkspaceIdentity(): Check {
  const identity = inspectWorkspaceId();
  switch (identity.status) {
    case "ready":
      return { name: "feedback-id", status: "ok", detail: "stable worktree identity ready" };
    case "missing":
      return {
        name: "feedback-id",
        status: "warn",
        detail: "not initialized — the next active hook will create it",
      };
    case "not_git":
      return {
        name: "feedback-id",
        status: "warn",
        detail: "not in a Git worktree — capture falls back to legacy V1",
      };
    case "corrupt":
      return {
        name: "feedback-id",
        status: "warn",
        detail: "identity is corrupt — not rotated; capture falls back to legacy V1",
      };
    case "unavailable":
      return {
        name: "feedback-id",
        status: "warn",
        detail: `identity unavailable during ${identity.operation} — capture falls back to legacy V1`,
      };
  }
}

function checkRepositoryIdentity(): Check {
  const repository = resolveRepositoryContext();
  if (!repository) {
    return { name: "repo-scope", status: "warn", detail: "not in a Git repository" };
  }
  if (!repository.repoKey) {
    return {
      name: "repo-scope",
      status: "warn",
      detail: "identity unavailable — configure origin or create the first commit",
    };
  }
  return {
    name: "repo-scope",
    status: "ok",
    detail: `canonical git-root paths · root ${repository.repoRoot} · key ${repository.repoKey.slice(0, 20)}… · ${repository.identitySource === "origin" ? "origin" : "root-commit"} identity`,
  };
}

function checkHookMode(): Check {
  const mode = readHookMode(process.env);
  return mode === "off"
    ? {
        name: "gate-mode",
        status: "warn",
        detail: process.env.PRIM_BYPASS ? "off (PRIM_BYPASS is set)" : "off (PRIM_HOOK_MODE=off)",
      }
    : {
        name: "gate-mode",
        status: mode === "warn" ? "warn" : "ok",
        detail: `${mode} · repository ${decisionIngestionStatus(process.cwd())}`,
      };
}

function checkEnforcementHooks(): Check {
  try {
    const claude = claudeStatus();
    const codex = codexStatus();
    const hermes = hermesStatus();
    const ready: string[] = [];
    if (claude.project.gateV2 || claude.user.gateV2) {
      ready.push("Claude: Edit, Write, MultiEdit, NotebookEdit, literal Bash");
    }
    if (codex.project.gate || codex.user.gate) ready.push("Codex: apply_patch");
    if (hermes.gate) ready.push("Hermes: write_file, patch");
    const claudeLegacy =
      (claude.project.gate || claude.user.gate) && !(claude.project.gateV2 || claude.user.gateV2);
    if (claudeLegacy) {
      return {
        name: "gate-hooks",
        status: "warn",
        detail: `Claude legacy/incomplete matcher — rerun \`prim claude install\`${ready.length > 0 ? ` · also ready: ${ready.join("; ")}` : ""}`,
      };
    }
    if (ready.length > 0) {
      return {
        name: "gate-hooks",
        status: "ok",
        detail: `v2 handlers · ${ready.join("; ")}`,
      };
    }
    return {
      name: "gate-hooks",
      status: "warn",
      detail: "not installed — run `prim claude install`",
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { name: "gate-hooks", status: "warn", detail: detail.slice(0, 80) };
  }
}

function checkFeedbackHooks(): Check {
  try {
    const status = claudeStatus();
    if (status.project.feedback || status.user.feedback) {
      return {
        name: "feedback-hooks",
        status: "ok",
        detail: status.project.feedback ? "project handlers ready" : "user handlers ready",
      };
    }
    return {
      name: "feedback-hooks",
      status: "warn",
      detail: "Stop + SessionStart handlers missing — run `prim claude install`",
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { name: "feedback-hooks", status: "warn", detail: message.slice(0, 80) };
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
    (typeof status.oldestPendingAgeMs === "number" && status.oldestPendingAgeMs < 0)
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
  let classification: Check;
  if (status.pendingSessionCount > 0) {
    const oldest =
      typeof status.oldestPendingAgeMs === "number"
        ? ` · oldest ${String(Math.round(status.oldestPendingAgeMs / MS_PER_SECOND))}s`
        : typeof status.oldestPendingAt === "number"
          ? ` · oldest ${String(Math.max(0, Math.round((Date.now() - status.oldestPendingAt) / MS_PER_SECOND)))}s`
          : "";
    classification = {
      name: "classification",
      status: "warn",
      detail: `${String(status.pendingSessionCount)} session(s) pending${oldest}${status.sampled ? " in a bounded sample" : ""}`,
    };
  } else if (status.sampled) {
    classification = {
      name: "classification",
      status: "warn",
      detail: "caught up in the bounded sample; older sessions were not inspected",
    };
  } else {
    classification = {
      name: "classification",
      status: "ok",
      detail:
        status.latestClassificationAt === null
          ? "no sessions awaiting classification"
          : `caught up · last ${new Date(status.latestClassificationAt).toISOString()}`,
    };
  }
  return [capture, classification];
}

async function checkBackend(): Promise<Check[]> {
  try {
    // Bypass the daemon so this independently verifies server reachability,
    // auth, capture entitlement, and the durable/classification read model.
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

function parseEnforcementReadiness(value: unknown): EnforcementReadiness {
  if (!value || typeof value !== "object") {
    throw new Error("readiness returned a non-object response");
  }
  const result = value as Partial<EnforcementReadiness>;
  if (
    typeof result.captureEnabled !== "boolean" ||
    typeof result.enforcementEnabled !== "boolean" ||
    typeof result.fileScopedDecisionCount !== "number" ||
    !Number.isInteger(result.fileScopedDecisionCount) ||
    result.fileScopedDecisionCount < 0 ||
    (result.lastPreflightAt !== null && typeof result.lastPreflightAt !== "number")
  ) {
    throw new Error("readiness returned an invalid response");
  }
  return result as EnforcementReadiness;
}

export function enforcementReadinessPath(repoKey: string | undefined): string {
  const params = new URLSearchParams();
  if (repoKey) params.set("repoKey", repoKey);
  return `/api/cli/decisions/readiness${params.size > 0 ? `?${params.toString()}` : ""}`;
}

export function classifyEnforcementReadiness(readiness: EnforcementReadiness): Check[] {
  const captureSource = readiness.captureEntitlementSource
    ? ` · ${readiness.captureEntitlementSource}`
    : "";
  const capture: Check = readiness.captureEnabled
    ? {
        name: "capture-entitlement",
        status: "ok",
        detail: `${readiness.captureEntitlementState ?? "enabled"}${captureSource}`,
      }
    : {
        name: "capture-entitlement",
        status: "fail",
        detail: `${readiness.captureEntitlementState ?? "disabled"}${captureSource}`,
      };
  const source = readiness.entitlementSource ? ` · ${readiness.entitlementSource}` : "";
  const entitlementUnavailable =
    !readiness.enforcementEnabled && readiness.enforcementEntitlementState === "unavailable";
  const entitlement: Check = readiness.enforcementEnabled
    ? {
        name: "enforcement",
        status: "ok",
        detail: `${readiness.enforcementEntitlementState ?? "enabled"}${source}`,
      }
    : {
        name: "enforcement",
        status: entitlementUnavailable ? "warn" : "ok",
        detail: `${readiness.enforcementEntitlementState ?? "not enabled"}${source}`,
      };
  const count = `${String(readiness.fileScopedDecisionCount)}${readiness.fileScopedDecisionCountTruncated ? "+" : ""}`;
  const scope: Check =
    readiness.enforcementEnabled && readiness.fileScopedDecisionCount === 0
      ? {
          name: "decision-scope",
          status: "warn",
          detail: "0 file-scoped Decisions — edits have no enforcement candidates",
        }
      : {
          name: "decision-scope",
          status: "ok",
          detail: `${count} file-scoped Decision(s)`,
        };
  const preflight: Check =
    readiness.enforcementEnabled && readiness.lastPreflightAt === null
      ? {
          name: "preflight",
          status: "warn",
          detail: "no successful v2 preflight recorded",
        }
      : {
          name: "preflight",
          status: "ok",
          detail:
            readiness.lastPreflightAt === null
              ? "none expected"
              : `${new Date(readiness.lastPreflightAt).toISOString()}${readiness.lastPreflightVerdict ? ` · ${readiness.lastPreflightVerdict}` : ""}${readiness.lastPreflightReasonCode ? ` · ${readiness.lastPreflightReasonCode}` : ""}`,
        };
  if (readiness.enforcementEnabled && (readiness.protocolVersion ?? 0) < 2) {
    preflight.status = "warn";
    preflight.detail = "server does not report v2 semantic preflight support";
  }
  const bypass: Check = readiness.bypassActive
    ? { name: "bypass", status: "warn", detail: "single-use reconcile bypass is active" }
    : { name: "bypass", status: "ok", detail: "none" };
  return [capture, entitlement, scope, preflight, bypass];
}

async function checkEnforcementReadiness(): Promise<Check[]> {
  try {
    const repoKey = resolveRepositoryContext()?.repoKey;
    const value = await getClient().get(enforcementReadinessPath(repoKey), {
      signal: AbortSignal.timeout(CONNECTIVITY_TIMEOUT_MS),
    });
    return classifyEnforcementReadiness(parseEnforcementReadiness(value));
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return [
        {
          name: "enforcement",
          status: "warn",
          detail: "server does not expose enforcement readiness yet",
        },
      ];
    }
    const detail = error instanceof Error ? error.message : String(error);
    return [{ name: "enforcement", status: "warn", detail: detail.slice(0, 100) }];
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

async function collectChecks(): Promise<Check[]> {
  const backend = await checkBackend();
  return [
    checkAuth(),
    await checkDaemon(),
    checkJournal(),
    checkStranded(),
    checkFeedbackHooks(),
    checkWorkspaceIdentity(),
    checkRepositoryIdentity(),
    checkHookMode(),
    checkEnforcementHooks(),
    ...backend,
    ...(await checkEnforcementReadiness()),
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
      "Check capture and feedback health end to end (auth, supervisor, delivery, worktree, server)",
    )
    .action(async () => {
      await runDoctor();
    });
}
