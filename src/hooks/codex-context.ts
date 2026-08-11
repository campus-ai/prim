/**
 * Codex-facing Primitive context.
 *
 * Codex has no useful live footer surface for the daemon state, so the
 * existing statusline renderer is delivered through the hook message paths.
 * This module owns only the small amount of state needed to make the Decision
 * digest session-scoped across the independent hook processes Codex launches.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getClient, getSiteUrl, isSessionEnded } from "../client.js";
import { daemonRequest } from "../daemon/client.js";
import { type DecisionFeedRow, fetchRecent } from "../decisions/recent.js";
import { decisionIngestionStatus } from "../lib/activation.js";
import { stripControlChars } from "../lib/ansi.js";
import { packageVersion } from "../lib/bin-path.js";
import { withFileLock } from "../lib/file-lock.js";
import { gitToplevel } from "../lib/git.js";
import { type StatusSnapshot, formatStatusline } from "../lib/statusline-render.js";

export const CODEX_CONTEXT_TIMEOUT_MS = 250;
export const CODEX_INITIAL_DIGEST_WINDOW = "24h";
export const CODEX_DIGEST_LIMIT = 10;
export const CODEX_DIGEST_VISIBLE_CAP = 3;
export const CODEX_DIGEST_OVERLAP_MS = 60_000;
export const CODEX_DIGEST_MAX_SEEN_IDS = 128;
export const CODEX_DIGEST_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const CODEX_DIGEST_STATE_MAX_FILES = 256;

const STATE_VERSION = 1;
const STATE_DIRECTORY = [".config", "prim", "codex", "decision-digests"] as const;

export interface CodexDecisionDigestState {
  version: typeof STATE_VERSION;
  sessionId: string;
  siteUrl: string;
  workspace: string;
  startedAt: number;
  watermarkMs: number;
  seenIds: string[];
  lastReport?: string;
  updatedAt: number;
}

export interface CodexContextResult {
  /** The context block to add, or undefined when a later report is unchanged. */
  context?: string;
  /** True when the feed was verified and the cursor may advance after handoff. */
  feedAvailable: boolean;
  /** Commit state only after the caller confirms stdout handoff succeeded. */
  acknowledge: (handedOff: boolean) => Promise<void>;
}

export interface CodexContextOptions {
  cwd: string;
  sessionId: string;
  startup?: boolean;
}

export interface CodexHookOutputLike {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: string;
    permissionDecisionReason?: string;
    additionalContext?: string;
    [key: string]: unknown;
  };
}

export function hasVisibleCodexMessage(output: unknown): boolean {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return false;
  const candidate = output as CodexHookOutputLike;
  return Boolean(
    candidate.systemMessage?.trim() ||
      candidate.hookSpecificOutput?.permissionDecisionReason?.trim() ||
      candidate.hookSpecificOutput?.additionalContext?.trim(),
  );
}

function appendContext(existing: string | undefined, context: string): string {
  return existing ? `${existing}\n\n${context}` : context;
}

/** Add status/digest context without changing the enforcement decision fields. */
export function appendCodexContext<T>(output: T, context: string | undefined): T {
  if (!context) return output;
  const candidate = output as CodexHookOutputLike;
  const next = { ...(output as object) } as CodexHookOutputLike;
  if (candidate.systemMessage) {
    next.systemMessage = appendContext(candidate.systemMessage, context);
  } else if (candidate.hookSpecificOutput?.permissionDecisionReason) {
    // A deny/ask has no system message, but its reason is already visible to
    // the user. Add the report beside it without touching the enforcement
    // decision or replacing the reason.
    next.systemMessage = context;
  } else if (candidate.hookSpecificOutput?.additionalContext) {
    next.hookSpecificOutput = {
      ...candidate.hookSpecificOutput,
      additionalContext: appendContext(candidate.hookSpecificOutput.additionalContext, context),
    };
  } else {
    next.systemMessage = context;
  }
  return next as T;
}

function stateRoot(): string {
  return join(homedir(), ...STATE_DIRECTORY);
}

function workspaceFor(cwd: string): string {
  try {
    return gitToplevel(cwd) ?? cwd;
  } catch {
    return cwd;
  }
}

function statePath(args: { cwd: string; sessionId: string; siteUrl: string }): string {
  const identity = `${args.siteUrl}\0${workspaceFor(args.cwd)}\0${args.sessionId}`;
  const key = createHash("sha256").update(identity).digest("hex");
  return join(stateRoot(), `${key}.json`);
}

function parseState(value: unknown): CodexDecisionDigestState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<CodexDecisionDigestState>;
  if (
    record.version !== STATE_VERSION ||
    typeof record.sessionId !== "string" ||
    typeof record.siteUrl !== "string" ||
    typeof record.workspace !== "string" ||
    typeof record.startedAt !== "number" ||
    typeof record.watermarkMs !== "number" ||
    !Array.isArray(record.seenIds) ||
    !record.seenIds.every((id) => typeof id === "string") ||
    typeof record.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    version: STATE_VERSION,
    sessionId: record.sessionId,
    siteUrl: record.siteUrl,
    workspace: record.workspace,
    startedAt: record.startedAt,
    watermarkMs: record.watermarkMs,
    seenIds: record.seenIds.slice(-CODEX_DIGEST_MAX_SEEN_IDS),
    lastReport: typeof record.lastReport === "string" ? record.lastReport : undefined,
    updatedAt: record.updatedAt,
  };
}

function readState(path: string): CodexDecisionDigestState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseState(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function writeState(path: string, state: CodexDecisionDigestState): void {
  const directory = stateRoot();
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
  const temporary = join(
    directory,
    `.${path.slice(directory.length + 1)}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`,
  );
  try {
    writeFileSync(temporary, `${JSON.stringify(state)}\n`, {
      encoding: "utf8",
      mode: 0o600,
      flag: "wx",
    });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    try {
      unlinkSync(temporary);
    } catch {
      // The rename path already removed the temporary file.
    }
  }
}

function cleanupStateFiles(now: number): void {
  const directory = stateRoot();
  if (!existsSync(directory)) return;
  let files: { path: string; mtimeMs: number }[] = [];
  try {
    files = readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .map((name) => {
        const path = join(directory, name);
        return { path, mtimeMs: statSync(path).mtimeMs };
      });
  } catch {
    return;
  }
  const stale = files.filter((file) => now - file.mtimeMs > CODEX_DIGEST_STATE_RETENTION_MS);
  const excess = files
    .filter((file) => !stale.some((candidate) => candidate.path === file.path))
    .sort((a, b) => a.mtimeMs - b.mtimeMs)
    .slice(0, Math.max(0, files.length - CODEX_DIGEST_STATE_MAX_FILES));
  for (const file of [...stale, ...excess]) {
    try {
      unlinkSync(file.path);
    } catch {
      // State cleanup is best effort and never affects the hook result.
    }
  }
}

function isChangeDecision(row: DecisionFeedRow): boolean {
  // The current recent-feed contract is Decision-only. When a newer backend
  // includes the discriminator, keep every organization-wide change row while
  // excluding unrelated intent kinds without filtering by producer.
  return row.intentKind === undefined || row.intentKind === "change";
}

function safeInline(value: string | undefined, fallback: string): string {
  const clean = stripControlChars(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= 240 ? clean : `${clean.slice(0, 239)}…`;
}

export function renderDecisionDigest(rows: readonly DecisionFeedRow[]): string | undefined {
  if (rows.length === 0) return undefined;
  const visible = rows.slice(0, CODEX_DIGEST_VISIBLE_CAP).map((row) => {
    const author = safeInline(row.authorName, "(unknown)");
    const intent = safeInline(row.intent, "(untitled Decision)");
    return `${author} — ${intent}`;
  });
  const overflow =
    rows.length > CODEX_DIGEST_VISIBLE_CAP
      ? ` +${String(rows.length - CODEX_DIGEST_VISIBLE_CAP)}`
      : "";
  return `[prim] Decisions since last message: ${visible.join("; ")}${overflow}`;
}

function reauthSnapshot(sessionId: string): StatusSnapshot {
  return {
    pid: 0,
    uptimeMs: 0,
    sessionId,
    healthy: false,
    needsReauth: true,
  };
}

function mergeState(
  latest: CodexDecisionDigestState | undefined,
  args: {
    sessionId: string;
    siteUrl: string;
    workspace: string;
    startedAt: number;
    watermarkMs: number;
    seenIds: string[];
    report: string;
    feedAvailable: boolean;
    now: number;
  },
): CodexDecisionDigestState {
  const seen = new Set(latest?.seenIds ?? []);
  for (const id of args.seenIds) seen.add(id);
  return {
    version: STATE_VERSION,
    sessionId: args.sessionId,
    siteUrl: args.siteUrl,
    workspace: args.workspace,
    startedAt: latest?.startedAt ?? args.startedAt,
    watermarkMs: args.feedAvailable
      ? Math.max(latest?.watermarkMs ?? 0, args.watermarkMs)
      : (latest?.watermarkMs ?? args.startedAt),
    seenIds: [...seen].slice(-CODEX_DIGEST_MAX_SEEN_IDS),
    lastReport: args.report,
    updatedAt: args.now,
  };
}

async function commitState(
  path: string,
  args: Parameters<typeof mergeState>[1],
  hasPreviousState: boolean,
): Promise<void> {
  // An unavailable feed must not create a new cursor. That preserves the
  // startup backlog for the first successful fetch in this session.
  if (!args.feedAvailable && !hasPreviousState) return;
  try {
    await withFileLock(
      `${path}.lock`,
      () => {
        const latest = readState(path);
        writeState(path, mergeState(latest, args));
        cleanupStateFiles(args.now);
      },
      { timeoutMs: 50, pollMs: 10 },
    );
  } catch {
    // A cursor write failure is safe: the next visible message may redeliver,
    // but it must never make a hook fail or suppress the Decision action.
  }
}

/** Prepare the status/digest block for one Codex hook message. */
export async function prepareCodexContext(
  options: CodexContextOptions,
): Promise<CodexContextResult> {
  const siteUrl = getSiteUrl();
  const workspace = workspaceFor(options.cwd);
  const path = statePath({ cwd: options.cwd, sessionId: options.sessionId, siteUrl });
  const previous = readState(path);
  const startup = options.startup === true;
  const startedAt = previous?.startedAt ?? Date.now();
  const terminalAuth = isSessionEnded();

  let snapshot: StatusSnapshot | null = null;
  if (terminalAuth) {
    snapshot = reauthSnapshot(options.sessionId);
  } else {
    snapshot = await daemonRequest<StatusSnapshot>(
      "status_snapshot",
      { callerEnv: siteUrl },
      { timeoutMs: CODEX_CONTEXT_TIMEOUT_MS },
    );
  }
  const report = formatStatusline(
    packageVersion() ?? "0.0.0",
    snapshot,
    () => decisionIngestionStatus(options.cwd),
    { includeIngestionWhenUnavailable: true },
  );
  const reportChanged = startup || previous?.lastReport !== report;

  let feedAvailable = false;
  let freshRows: DecisionFeedRow[] = [];
  if (!terminalAuth) {
    const since = previous
      ? String(Math.max(0, previous.watermarkMs - CODEX_DIGEST_OVERLAP_MS))
      : CODEX_INITIAL_DIGEST_WINDOW;
    const recent = await fetchRecent(
      { limit: CODEX_DIGEST_LIMIT, since },
      { getClient, timeoutMs: CODEX_CONTEXT_TIMEOUT_MS },
    );
    feedAvailable = recent.unavailable === undefined && Array.isArray(recent.decisions);
    if (feedAvailable) {
      const seen = new Set(previous?.seenIds ?? []);
      freshRows = recent.decisions.filter((row) => isChangeDecision(row) && !seen.has(row.id));
    }
  }

  const digest = renderDecisionDigest(freshRows);
  const context =
    [reportChanged ? report : undefined, digest]
      .filter((value): value is string => value !== undefined)
      .join("\n\n") || undefined;
  let acknowledged = false;
  return {
    context,
    feedAvailable,
    acknowledge: async (handedOff) => {
      if (!handedOff || acknowledged) return;
      acknowledged = true;
      await commitState(
        path,
        {
          sessionId: options.sessionId,
          siteUrl,
          workspace,
          startedAt,
          watermarkMs: Date.now(),
          seenIds: freshRows.map((row) => row.id),
          report,
          feedAvailable,
          now: Date.now(),
        },
        previous !== undefined,
      );
    },
  };
}
