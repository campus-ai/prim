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
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { getSiteUrl, isSessionEnded } from "../client.js";
import { daemonRequest } from "../daemon/client.js";
import {
  DECISION_DIGEST_CACHE_LIMIT,
  type DecisionDigestCacheSnapshot,
} from "../daemon/decision-digest-cache.js";
import { daemonPrincipalsMatch, resolveDaemonPrincipal } from "../daemon/principal.js";
import type { DecisionFeedRow } from "../decisions/recent.js";
import { decisionIngestionStatus, repositoryBindingState } from "../lib/activation.js";
import { packageVersion } from "../lib/bin-path.js";
import { withFileLock } from "../lib/file-lock.js";
import { gitToplevel } from "../lib/git.js";
import { primConfigDirectory } from "../lib/paths.js";
import { type StatusSnapshot, formatStatusline } from "../lib/statusline-render.js";
import { terminalSafeText } from "../lib/terminal-safe.js";

export const CODEX_CONTEXT_TIMEOUT_MS = 250;
// The daemon cache uses the server's RECENT_LIMIT_CEILING. The visible digest
// stays capped at 3; caching the widest page keeps the "+N" count honest and
// the cursor able to mark rows seen up to a 100-row burst.
export const CODEX_DIGEST_LIMIT = DECISION_DIGEST_CACHE_LIMIT;
export const CODEX_DIGEST_VISIBLE_CAP = 3;
export const CODEX_DIGEST_OVERLAP_MS = 60_000;
export const CODEX_DIGEST_MAX_SEEN_IDS = 128;
export const CODEX_DRAFT_DIGEST_MAX_SEEN_IDS = 4_096;
export const CODEX_DIGEST_STATE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const CODEX_DIGEST_STATE_MAX_FILES = 256;

const STATE_VERSION = 1;
const STATE_DIRECTORY = ["codex", "decision-digests"] as const;
const DRAFT_STATE_VERSION = 2;
const DRAFT_STATE_DIRECTORY = ["codex", "decision-draft-deliveries"] as const;
/**
 * watermarkMs sentinel: no feed page has been observed yet. The cursor is
 * server time — the highest `classifiedAt` seen — never the client clock, so
 * a skewed machine cannot silently skip rows classified inside its skew gap.
 */
const NO_CURSOR = -1;

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

export interface CodexDecisionDraftDeliveryState {
  version: typeof DRAFT_STATE_VERSION;
  sessionId: string;
  siteUrl: string;
  workspace: string;
  principalId: string;
  organizationId: string;
  /** SHA-256 of the bearer generation; never the bearer itself. */
  credentialFingerprint: string;
  /** Private drafts whose publish action was visibly handed off this session. */
  seenDraftIds: string[];
  updatedAt: number;
}

export interface CodexContextResult {
  /** The context block to add, or undefined when a later report is unchanged. */
  context?: string;
  /** Digest-only portion, used by Stop to decide whether to continue. */
  decisionDigest?: string;
  /** True when the feed was verified and the cursor may advance after handoff. */
  feedAvailable: boolean;
  /** Commit state only after the caller confirms stdout handoff succeeded. */
  acknowledge: (handedOff: boolean) => Promise<void>;
}

export interface CodexContextOptions {
  cwd: string;
  sessionId: string;
  startup?: boolean;
  /** Status-only callers leave the feed cursor untouched. Defaults to true. */
  includeDigest?: boolean;
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
  return join(primConfigDirectory(), ...STATE_DIRECTORY);
}

function draftStateRoot(): string {
  return join(primConfigDirectory(), ...DRAFT_STATE_DIRECTORY);
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

function draftStatePath(args: {
  cwd: string;
  sessionId: string;
  siteUrl: string;
  principalId: string;
  organizationId: string;
  credentialFingerprint: string;
}): string {
  const identity =
    `${args.siteUrl}\0${workspaceFor(args.cwd)}\0${args.sessionId}` +
    `\0${args.principalId}\0${args.organizationId}\0${args.credentialFingerprint}`;
  const key = createHash("sha256").update(identity).digest("hex");
  return join(draftStateRoot(), `${key}.json`);
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

function parseDraftState(value: unknown): CodexDecisionDraftDeliveryState | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Partial<CodexDecisionDraftDeliveryState>;
  if (
    record.version !== DRAFT_STATE_VERSION ||
    typeof record.sessionId !== "string" ||
    typeof record.siteUrl !== "string" ||
    typeof record.workspace !== "string" ||
    typeof record.principalId !== "string" ||
    typeof record.organizationId !== "string" ||
    typeof record.credentialFingerprint !== "string" ||
    !Array.isArray(record.seenDraftIds) ||
    !record.seenDraftIds.every((id) => typeof id === "string") ||
    typeof record.updatedAt !== "number"
  ) {
    return undefined;
  }
  return {
    version: DRAFT_STATE_VERSION,
    sessionId: record.sessionId,
    siteUrl: record.siteUrl,
    workspace: record.workspace,
    principalId: record.principalId,
    organizationId: record.organizationId,
    credentialFingerprint: record.credentialFingerprint,
    seenDraftIds: record.seenDraftIds.slice(-CODEX_DRAFT_DIGEST_MAX_SEEN_IDS),
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

function readDraftState(path: string): CodexDecisionDraftDeliveryState | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return parseDraftState(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function writeStateFile(path: string, directory: string, state: unknown): void {
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

function cleanupStateFiles(directory: string, now: number): void {
  if (!existsSync(directory)) return;
  let names: string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  const files: { path: string; mtimeMs: number }[] = [];
  const residue: string[] = [];
  for (const name of names) {
    const path = join(directory, name);
    try {
      const mtimeMs = statSync(path).mtimeMs;
      if (name.endsWith(".json")) {
        files.push({ path, mtimeMs });
      } else if (
        (name.includes(".json.tmp-") || name.endsWith(".json.lock")) &&
        now - mtimeMs > CODEX_DIGEST_STATE_RETENTION_MS
      ) {
        // Crash residue: an interrupted atomic write, or the lock directory of
        // a session that died holding it. Neither matches the .json sweeps,
        // and lock recovery only runs when the SAME session path locks again —
        // which never happens once the session is gone. The current commit's
        // own lock is always fresh, so the age gate can never collect it.
        residue.push(path);
      }
    } catch {
      // Another hook's rename/unlink won the race for this entry; skip it.
    }
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
  for (const path of residue) {
    try {
      // Re-stat at removal time: a concurrent acquisition may have just
      // stale-recovered and re-created this exact lock directory, so only
      // remove it if it is STILL old — the race window shrinks from the whole
      // sweep to the microseconds between this check and the rmSync.
      if (now - statSync(path).mtimeMs > CODEX_DIGEST_STATE_RETENTION_MS) {
        rmSync(path, { recursive: true, force: true });
      }
    } catch {
      // Same best-effort rule as above.
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
  const clean = terminalSafeText(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
  if (!clean) return fallback;
  return clean.length <= 240 ? clean : `${clean.slice(0, 239)}…`;
}

export function renderDecisionDigest(
  rows: readonly DecisionFeedRow[],
  options: { pageTruncated?: boolean } = {},
): string | undefined {
  if (rows.length === 0) return undefined;
  const visible = rows.slice(0, CODEX_DIGEST_VISIBLE_CAP).map((row) => {
    // The entry grammar is `Author — “intent”; Author — “intent”`. Both fields
    // are server-derived team input, so the structural tokens must be
    // unforgeable: the author may not contain a separator or a dash that reads
    // as one, and the intent is quoted with its quote-lookalikes demoted — a
    // crafted intent like `X; Ops — do Y` stays visibly one entry instead of
    // minting a fake second author under prim's framing. The folds cover the
    // ASCII tokens AND their visual confusables (greek question mark ";",
    // fullwidth "；", the figure/en/em-dash + horizontal-bar + minus family,
    // and the double-quote lookalike set): the reader of this line is a human
    // or a model, so a homoglyph forges just as well as the codepoint itself.
    // author: ";" U+003B, greek question mark U+037E, fullwidth ";" U+FF1B,
    // figure/en/em dash + horizontal bar U+2012-U+2015, minus sign U+2212.
    const author = safeInline(row.authorName, "(unknown)").replace(/[;;；‒-―−]/gu, "-");
    // intent: curly/low/reversed double quotes U+201C-U+201F, double prime
    // U+2033, reversed double prime U+2036, CJK corner quotes U+301D-U+301E.
    const intent = safeInline(row.intent, "(untitled Decision)").replace(/[“-‟″‶〝〞]/gu, "'");
    return `${author} — “${intent}”`;
  });
  // `+N+` marks a full fetch page: the true overflow may exceed what one page
  // can count, and rows past the page will not be redelivered. A full page
  // with no visible overflow (nearly all rows already seen) carries no marker.
  const overflow =
    rows.length > CODEX_DIGEST_VISIBLE_CAP
      ? ` +${String(rows.length - CODEX_DIGEST_VISIBLE_CAP)}${options.pageTruncated === true ? "+" : ""}`
      : "";
  return `[prim] Decisions captured since last message: ${visible.join("; ")}${overflow}`;
}

export interface RenderedDecisionDraftDigest {
  message: string;
  /** Only rows with a command in `message`; safe to persist after handoff. */
  deliveredIds: string[];
}

function actionablePrivateDrafts(rows: readonly DecisionFeedRow[]): DecisionFeedRow[] {
  const seen = new Set<string>();
  return rows.filter((row) => {
    if (
      typeof row !== "object" ||
      row === null ||
      typeof row.id !== "string" ||
      row.id.length === 0 ||
      row.id.length > 128 ||
      terminalSafeText(row.id) !== row.id ||
      typeof row.intent !== "string" ||
      row.authorIsSelf !== true ||
      row.stage !== "draft" ||
      (row.intentKind !== undefined && row.intentKind !== "change") ||
      seen.has(row.id)
    ) {
      return false;
    }
    seen.add(row.id);
    return true;
  });
}

/** Render author-private drafts without prompting or consuming hidden rows. */
export function renderDecisionDraftDigest(
  rows: readonly DecisionFeedRow[],
  options: { pageTruncated?: boolean } = {},
): RenderedDecisionDraftDigest | undefined {
  const eligible = actionablePrivateDrafts(rows);
  if (eligible.length === 0) return undefined;
  const visible = eligible.slice(0, CODEX_DIGEST_VISIBLE_CAP);
  const lines = visible.flatMap((row) => {
    const identifier = row.id;
    const intent = safeInline(row.intent, "(untitled Decision)").replace(/[`“-‟″‶〝〞]/gu, "'");
    return [
      `[prim] private Decision ${identifier} · stage: draft · “${intent}”`,
      `[prim] Run \`prim decisions publish ${identifier}\` to share it with your team.`,
    ];
  });
  if (eligible.length > visible.length) {
    const suffix = options.pageTruncated === true ? "+" : "";
    lines.push(
      `[prim] +${String(eligible.length - visible.length)}${suffix} private Decision drafts remain for later messages.`,
    );
  }
  return { message: lines.join("\n"), deliveredIds: visible.map((row) => row.id) };
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
    // Advance only on an observed page (server classifiedAt time), never the
    // client clock; an unavailable feed keeps the previous cursor — or the
    // NO_CURSOR sentinel, so the startup backlog survives until the first
    // successful fetch.
    watermarkMs: args.feedAvailable
      ? Math.max(latest?.watermarkMs ?? NO_CURSOR, args.watermarkMs)
      : (latest?.watermarkMs ?? NO_CURSOR),
    seenIds: [...seen].slice(-CODEX_DIGEST_MAX_SEEN_IDS),
    lastReport: args.report,
    updatedAt: args.now,
  };
}

async function commitState(path: string, args: Parameters<typeof mergeState>[1]): Promise<void> {
  // Always write: the record also carries lastReport, which dedups the
  // situation report across messages even while the feed is unavailable
  // (offline, org-unbound). The digest cursor itself stays at NO_CURSOR until
  // a page is actually observed, so writing never forfeits the 24h backlog.
  try {
    await withFileLock(
      `${path}.lock`,
      () => {
        const latest = readState(path);
        writeStateFile(path, stateRoot(), mergeState(latest, args));
        cleanupStateFiles(stateRoot(), args.now);
      },
      { timeoutMs: 50, pollMs: 10 },
    );
  } catch {
    // A cursor write failure is safe: the next visible message may redeliver,
    // but it must never make a hook fail or suppress the Decision action.
  }
}

function mergeDraftState(
  latest: CodexDecisionDraftDeliveryState | undefined,
  args: {
    sessionId: string;
    siteUrl: string;
    workspace: string;
    principalId: string;
    organizationId: string;
    credentialFingerprint: string;
    deliveredIds: string[];
    now: number;
  },
): CodexDecisionDraftDeliveryState {
  const seen = new Set(latest?.seenDraftIds ?? []);
  for (const id of args.deliveredIds) seen.add(id);
  return {
    version: DRAFT_STATE_VERSION,
    sessionId: args.sessionId,
    siteUrl: args.siteUrl,
    workspace: args.workspace,
    principalId: args.principalId,
    organizationId: args.organizationId,
    credentialFingerprint: args.credentialFingerprint,
    seenDraftIds: [...seen].slice(-CODEX_DRAFT_DIGEST_MAX_SEEN_IDS),
    updatedAt: args.now,
  };
}

async function commitDraftState(
  path: string,
  args: Parameters<typeof mergeDraftState>[1],
): Promise<void> {
  try {
    await withFileLock(
      `${path}.lock`,
      () => {
        const latest = readDraftState(path);
        writeStateFile(path, draftStateRoot(), mergeDraftState(latest, args));
        cleanupStateFiles(draftStateRoot(), args.now);
      },
      { timeoutMs: 50, pollMs: 10 },
    );
  } catch {
    // Redelivery is safer than losing a private publish action.
  }
}

/** Prepare the status/digest block from daemon-local snapshots for one Codex hook message. */
export async function prepareCodexContext(
  options: CodexContextOptions,
): Promise<CodexContextResult> {
  const siteUrl = getSiteUrl();
  const workspace = workspaceFor(options.cwd);
  const path = statePath({ cwd: options.cwd, sessionId: options.sessionId, siteUrl });
  const previous = readState(path);
  const principal = resolveDaemonPrincipal();
  const privatePath = principal
    ? draftStatePath({
        cwd: options.cwd,
        sessionId: options.sessionId,
        siteUrl,
        principalId: principal.principalId,
        organizationId: principal.organizationId,
        credentialFingerprint: principal.credentialFingerprint,
      })
    : undefined;
  const previousDraft = privatePath ? readDraftState(privatePath) : undefined;
  const startup = options.startup === true;
  const includeDigest = options.includeDigest !== false;
  const startedAt = previous?.startedAt ?? Date.now();
  const terminalAuth = isSessionEnded();

  let snapshot: StatusSnapshot | null = null;
  let recent: DecisionDigestCacheSnapshot | null = null;
  let recentDrafts: DecisionDigestCacheSnapshot | null = null;
  if (terminalAuth) {
    snapshot = reauthSnapshot(options.sessionId);
  } else {
    [snapshot, recent, recentDrafts] = await Promise.all([
      daemonRequest<StatusSnapshot>(
        "status_snapshot",
        { callerEnv: siteUrl },
        { timeoutMs: CODEX_CONTEXT_TIMEOUT_MS },
      ),
      includeDigest && principal !== undefined
        ? daemonRequest<DecisionDigestCacheSnapshot>(
            "decision_digest_snapshot",
            { callerEnv: siteUrl },
            { timeoutMs: CODEX_CONTEXT_TIMEOUT_MS },
          )
        : Promise.resolve(null),
      includeDigest && principal !== undefined
        ? daemonRequest<DecisionDigestCacheSnapshot>(
            "decision_draft_digest_snapshot",
            { callerEnv: siteUrl },
            { timeoutMs: CODEX_CONTEXT_TIMEOUT_MS },
          )
        : Promise.resolve(null),
    ]);
    if (principal !== undefined && !daemonPrincipalsMatch(principal, resolveDaemonPrincipal())) {
      // Every socket request resolves its caller independently. If the local
      // credential generation changes while these requests are in flight,
      // their snapshots may belong to either side of the rotation. Withhold
      // all organization-scoped output and leave both delivery cursors
      // untouched; the next hook retries under one stable principal.
      snapshot = null;
      recent = null;
      recentDrafts = null;
    }
  }
  let ingestionStatus: ReturnType<typeof decisionIngestionStatus> | undefined;
  const resolveIngestionStatus = () => {
    ingestionStatus ??= decisionIngestionStatus(options.cwd);
    return ingestionStatus;
  };
  const report = formatStatusline(packageVersion() ?? "0.0.0", snapshot, resolveIngestionStatus, {
    includeIngestionWhenUnavailable: true,
    plainLinks: true,
    resolveRepositoryBindingState: () =>
      resolveIngestionStatus() === "enabled" ? repositoryBindingState(options.cwd) : undefined,
  });
  const reportChanged = startup || previous?.lastReport !== report;

  let feedAvailable = false;
  let freshRows: DecisionFeedRow[] = [];
  let pageTruncated = false;
  let pageWatermark = NO_CURSOR;
  if (!terminalAuth && includeDigest && recent !== null) {
    feedAvailable = recent.unavailable === undefined && Array.isArray(recent.decisions);
    if (feedAvailable) {
      const seen = new Set(previous?.seenIds ?? []);
      const lowerBound =
        previous !== undefined && previous.watermarkMs >= 0
          ? Math.max(0, previous.watermarkMs - CODEX_DIGEST_OVERLAP_MS)
          : 0;
      freshRows = recent.decisions.filter(
        (row) =>
          isChangeDecision(row) &&
          !seen.has(row.id) &&
          typeof row.classifiedAt === "number" &&
          row.classifiedAt >= lowerBound,
      );
      pageTruncated = recent.decisions.length >= CODEX_DIGEST_LIMIT;
      // The cursor is the newest server classifiedAt on the page — rows are
      // wire passthrough, so guard the field before trusting it.
      pageWatermark = recent.decisions.reduce(
        (max, row) =>
          typeof row.classifiedAt === "number" && row.classifiedAt > max ? row.classifiedAt : max,
        NO_CURSOR,
      );
    }
  }

  const digest = renderDecisionDigest(freshRows, { pageTruncated });
  let draftDigest: RenderedDecisionDraftDigest | undefined;
  if (
    !terminalAuth &&
    includeDigest &&
    recentDrafts !== null &&
    recentDrafts.unavailable === undefined &&
    Array.isArray(recentDrafts.decisions)
  ) {
    const seenDrafts = new Set(previousDraft?.seenDraftIds ?? []);
    const freshDrafts = recentDrafts.decisions.filter(
      (row) =>
        typeof row === "object" &&
        row !== null &&
        typeof row.id === "string" &&
        !seenDrafts.has(row.id),
    );
    draftDigest = renderDecisionDraftDigest(freshDrafts, {
      pageTruncated:
        recentDrafts.pageDone === false ||
        (recentDrafts.pageDone === undefined &&
          recentDrafts.decisions.length >= CODEX_DIGEST_LIMIT),
    });
  }
  const combinedDigest = [digest, draftDigest?.message]
    .filter((value): value is string => value !== undefined)
    .join("\n\n");
  const context =
    [reportChanged ? report : undefined, combinedDigest || undefined]
      .filter((value): value is string => value !== undefined)
      .join("\n\n") || undefined;
  let acknowledged = false;
  return {
    context,
    decisionDigest: combinedDigest || undefined,
    feedAvailable,
    acknowledge: async (handedOff) => {
      if (!handedOff || acknowledged) return;
      acknowledged = true;
      const now = Date.now();
      const commits: Promise<void>[] = [
        commitState(path, {
          sessionId: options.sessionId,
          siteUrl,
          workspace,
          startedAt,
          watermarkMs: pageWatermark,
          seenIds: freshRows.map((row) => row.id),
          report,
          feedAvailable,
          now,
        }),
      ];
      if (
        privatePath !== undefined &&
        principal !== undefined &&
        draftDigest !== undefined &&
        draftDigest.deliveredIds.length > 0
      ) {
        commits.push(
          commitDraftState(privatePath, {
            sessionId: options.sessionId,
            siteUrl,
            workspace,
            principalId: principal.principalId,
            organizationId: principal.organizationId,
            credentialFingerprint: principal.credentialFingerprint,
            // Only IDs whose exact publish command was included in the
            // handed-off bytes may advance the private state.
            deliveredIds: draftDigest.deliveredIds,
            now,
          }),
        );
      }
      await Promise.all(commits);
    },
  };
}
