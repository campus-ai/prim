/**
 * `prim doctor` — one-shot capture-pipeline health check.
 *
 * Answers "is decision capture actually working, end to end?" in a single
 * command, instead of forcing an operator to correlate `auth status`,
 * `daemon status`, `moves status`, and a filesystem listing by hand (the
 * ~20-minute archaeology the user study turned into). Checks auth, daemon
 * liveness, journals, worktree identity, server reachability, and decision-
 * feedback capability, then renders them
 * verdict-first on STDERR with machine-readable JSON on STDOUT, exiting
 * non-zero when a check is red so an agent or installer can gate on it.
 *
 * AX contract: STDERR verdict-first; STDOUT machine-readable JSON.
 */

import { existsSync } from "node:fs";
import type { Command } from "commander";
import {
  HttpError,
  REFRESH_TOKEN_PATH,
  getAuthToken,
  getClient,
  getTokenExpiresAt,
} from "../client.js";
import { daemonIsLive } from "../daemon/client.js";
import { fetchFeedbackCapability } from "../decisions/feedback.js";
import { bucketStats, listFlushing } from "../journal.js";
import { inspectWorkspaceId } from "../lib/workspace-id.js";
import { performStatus as claudeStatus } from "./claude-install.js";

const DAEMON_PROBE_TIMEOUT_MS = 500;
const CONNECTIVITY_TIMEOUT_MS = 3_000;
const MS_PER_SECOND = 1000;
// Past this the opportunistic drain should already have fired, so a journal
// still pending beyond it is a signal, not normal lag. Mirrors the flusher's
// OPPORTUNISTIC_FLUSH_AFTER_MS.
const STALE_PENDING_MS = 60_000;
const EXIT_UNHEALTHY = 1;

export type CheckStatus = "ok" | "warn" | "fail";
export type Check = { name: string; status: CheckStatus; detail: string };

export type DoctorVerdict = {
  json: { ok: boolean; status: CheckStatus; checks: Check[] };
  exitCode: number;
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

function checkAuth(): Check {
  if (!getAuthToken()) {
    return { name: "auth", status: "fail", detail: "no token — run `prim auth login`" };
  }
  const expiresAt = getTokenExpiresAt();
  const hasRefresh = existsSync(REFRESH_TOKEN_PATH);
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

async function checkDaemon(): Promise<Check> {
  const live = await daemonIsLive(DAEMON_PROBE_TIMEOUT_MS);
  return live
    ? { name: "daemon", status: "ok", detail: "live" }
    : {
        name: "daemon",
        status: "warn",
        detail: "down — capture still journals; drains on next `prim` invocation",
      };
}

function checkJournal(): Check {
  const stats = bucketStats();
  const pending = stats.reduce((n, s) => n + s.lineCount, 0);
  if (pending === 0) {
    return { name: "journal", status: "ok", detail: "no pending moves" };
  }
  const oldestMs = Math.max(...stats.map((s) => Date.now() - s.mtimeMs));
  const oldestS = Math.round(oldestMs / MS_PER_SECOND);
  if (oldestMs > STALE_PENDING_MS) {
    return {
      name: "journal",
      status: "warn",
      detail: `${String(pending)} pending, oldest ${String(oldestS)}s — drain may be stalled`,
    };
  }
  return { name: "journal", status: "ok", detail: `${String(pending)} pending, draining` };
}

function checkStranded(): Check {
  const stranded = listFlushing();
  if (stranded.length === 0) {
    return { name: "stranded", status: "ok", detail: "none" };
  }
  const moves = stranded.reduce((n, f) => n + f.lineCount, 0);
  return {
    name: "stranded",
    status: "warn",
    detail: `${String(moves)} move(s) in ${String(stranded.length)} file(s) — run \`prim moves flush\``,
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

async function checkConnectivity(): Promise<Check> {
  try {
    // Probe the real server with the stored token (bypassing the daemon
    // proxy) so this verifies reachability AND auth end to end.
    await getClient().get("/api/cli/decisions/recent?limit=1", {
      signal: AbortSignal.timeout(CONNECTIVITY_TIMEOUT_MS),
    });
    return { name: "connectivity", status: "ok", detail: "server reachable" };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A 401 is an actionable auth failure; anything else (timeout, network,
    // 5xx) is a softer "can't reach right now".
    const status: CheckStatus = message.includes("Authentication") ? "fail" : "warn";
    return { name: "connectivity", status, detail: message.slice(0, 80) };
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
  return [
    checkAuth(),
    await checkDaemon(),
    checkJournal(),
    checkStranded(),
    checkFeedbackHooks(),
    checkWorkspaceIdentity(),
    await checkConnectivity(),
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
      "Check capture and feedback health end to end (auth, daemon, journal, worktree, server)",
    )
    .action(async () => {
      await runDoctor();
    });
}
