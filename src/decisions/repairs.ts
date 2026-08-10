/**
 * `prim decisions repairs` — inspect and resolve human-gated commit repairs.
 *
 * Listing is intentionally fail-closed: every bounded page is validated and
 * collected through `isDone` before callers receive anything to render. A
 * confirmation requires the explicit token printed with that human-reviewed
 * complete set; it never silently replaces the set with a fresh read.
 *
 * AX contract: STDOUT is machine-readable JSON; STDERR is a verdict-first
 * human summary. Confirmation queues fresh landing proof. It never claims the
 * repair was applied synchronously.
 */

import { type CliClient, HttpError, getClient } from "../client.js";
import { stripControlChars } from "../lib/ansi.js";
import { renderIdentifier } from "./recent.js";

export type CommitRepairMatchTier = "exact_patch_body" | "exact_file_set";
export type CommitRepairProposalStatus = "proposed" | "confirmed" | "verification_failed";
export type RepairDecisionStatus = "provisional" | "abandoned";

export interface CommitRepairProposal {
  _id: string;
  repoFullName: string;
  deadCommitSha: string;
  status: CommitRepairProposalStatus;
  proposedSha?: string;
  proposedTier?: CommitRepairMatchTier;
  signals: string[];
  lastEvaluatedAt: number;
  nextEvaluateAt?: number;
}

/** The bounded, redacted decision projection exposed by the review route. */
export interface RepairDecision {
  _id: string;
  shortId?: string;
  intent: string;
  status: RepairDecisionStatus;
  intentTruncated: boolean;
}

export interface CommitRepairListItem {
  proposal: CommitRepairProposal;
  decisions: RepairDecision[];
  /** Null means the server could not determine an exact count within its bound. */
  affectedDecisionCount: number | null;
  decisionsTruncated: boolean;
  /** Binds confirmation to the exact candidate and complete decision set shown. */
  reviewToken: string | null;
}

/** A successful client result is always an exhaustive, non-truncated scan. */
export interface RepairsListResult {
  repairs: CommitRepairListItem[];
  isDone: true;
  nextCursor: null;
  truncated: false;
}

interface RepairsListPage {
  repairs: CommitRepairListItem[];
  isDone: boolean;
  nextCursor: string | null;
  truncated: boolean;
}

export type RepairResolutionAction = "confirm" | "reject";
type RepairResolutionStatus =
  | "confirmed"
  | "rejected"
  | "already_applied"
  | "disabled"
  | "no_op"
  | "review_too_large"
  | "stale_review"
  | "stale";

export type RepairResolutionOutcome =
  | { status: RepairResolutionStatus }
  | { status: "backoff"; retryAt: number };

export interface RepairResolutionResult {
  proposalId: string;
  action: RepairResolutionAction;
  outcome: RepairResolutionOutcome;
}

export const REPAIRS_TIMEOUT_MS = 10_000;
export const MAX_REPAIR_LIST_PAGES = 100;
export const MAX_REPAIR_DECISIONS_FOR_CONFIRM = 25;

const MAX_REPAIRS_PER_PAGE = 10;
const MAX_CURSOR_LENGTH = 4096;
const MAX_INTENT_LENGTH = 1000;
const MAX_SIGNALS = 8;
const MAX_SIGNAL_LENGTH = 160;
const SHA_RE = /^[0-9a-f]{40}$/u;
const SHA_INPUT_RE = /^[0-9a-f]{40}$/iu;
const REVIEW_TOKEN_RE = /^[0-9a-f]{64}$/u;
const REVIEW_TOKEN_INPUT_RE = /^[0-9a-f]{64}$/iu;
const REPO_FULL_NAME_RE = /^[a-z0-9_.-]+\/[a-z0-9_.-]+$/u;
const REVIEWED_CONFIRM_WIRE_ACTION = "confirm_reviewed_v2";
const LEGACY_REPAIR_BODY_ERROR =
  "Body requires id, action (confirm or reject), and expectedProposedSha";
const LEGACY_CONFIRM_PROTOCOL_ERROR =
  "Reviewed confirmation protocol required; legacy action confirm is not supported";

export interface RepairsDeps {
  getClient: () => CliClient;
  /** Test seam. Production still clamps this to MAX_REPAIR_LIST_PAGES. */
  maxPages?: number;
}

const defaultDeps: RepairsDeps = { getClient };

export class RepairProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`Commit repair proposal not found: ${oneLine(proposalId)}`);
    this.name = "RepairProposalNotFoundError";
  }
}

export class RepairAuthorizationError extends Error {
  constructor() {
    super(
      "Not authorized to review commit repairs; active organization membership and current repository authorization are required",
    );
    this.name = "RepairAuthorizationError";
  }
}

export class RepairListContractError extends Error {
  constructor(detail: string) {
    super(`Commit repair response violated the reviewed CLI contract: ${oneLine(detail)}`);
    this.name = "RepairListContractError";
  }
}

export class RepairEndpointVersionError extends Error {
  constructor() {
    super(
      "The selected server must be upgraded for the reviewed commit-repair contract; nothing was confirmed or queued (client/server version skew)",
    );
    this.name = "RepairEndpointVersionError";
  }
}

export class RepairResolutionInputError extends Error {
  constructor(detail: string) {
    super(`Invalid commit repair resolution: ${oneLine(detail)}`);
    this.name = "RepairResolutionInputError";
  }
}

function contractError(path: string, detail: string): never {
  throw new RepairListContractError(`${path} ${detail}`);
}

function asRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    contractError(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function assertKeys(
  record: Record<string, unknown>,
  path: string,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const allowed = new Set([...required, ...optional]);
  const missing = required.find((key) => !Object.hasOwn(record, key));
  if (missing !== undefined) contractError(path, `is missing ${missing}`);
  const extra = Object.keys(record).find((key) => !allowed.has(key));
  if (extra !== undefined) contractError(path, `contains unexpected field ${extra}`);
}

function asString(
  value: unknown,
  path: string,
  options: { max: number; nonempty?: boolean },
): string {
  if (typeof value !== "string") contractError(path, "must be a string");
  if (options.nonempty && value.length === 0) contractError(path, "must not be empty");
  if (value.length > options.max) contractError(path, "exceeds its length bound");
  return value;
}

function asTimestamp(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    contractError(path, "must be a non-negative safe integer timestamp");
  }
  return value;
}

function asCount(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    contractError(path, "must be a non-negative safe integer");
  }
  return value;
}

function asBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") contractError(path, "must be a boolean");
  return value;
}

function asSha(value: unknown, path: string): string {
  const sha = asString(value, path, { max: 40, nonempty: true });
  if (!SHA_RE.test(sha)) contractError(path, "must be a canonical lowercase Git commit SHA");
  return sha;
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  path: string,
  max: number,
): string | undefined {
  if (!Object.hasOwn(record, key)) return undefined;
  return asString(record[key], `${path}.${key}`, { max, nonempty: true });
}

function parseProposal(value: unknown, path: string): CommitRepairProposal {
  const record = asRecord(value, path);
  assertKeys(
    record,
    path,
    ["_id", "repoFullName", "deadCommitSha", "status", "signals", "lastEvaluatedAt"],
    ["proposedSha", "proposedTier", "nextEvaluateAt"],
  );
  const repoFullName = asString(record.repoFullName, `${path}.repoFullName`, {
    max: 200,
    nonempty: true,
  });
  if (!REPO_FULL_NAME_RE.test(repoFullName)) {
    contractError(`${path}.repoFullName`, "must be canonical owner/repository syntax");
  }
  const status = record.status;
  if (status !== "proposed" && status !== "confirmed" && status !== "verification_failed") {
    contractError(`${path}.status`, "is not a review-visible proposal status");
  }
  if (!Array.isArray(record.signals) || record.signals.length > MAX_SIGNALS) {
    contractError(`${path}.signals`, "must be a bounded array");
  }
  const signals = record.signals.map((signal, index) =>
    asString(signal, `${path}.signals[${String(index)}]`, {
      max: MAX_SIGNAL_LENGTH,
      nonempty: true,
    }),
  );
  const proposedSha = Object.hasOwn(record, "proposedSha")
    ? asSha(record.proposedSha, `${path}.proposedSha`)
    : undefined;
  let proposedTier: CommitRepairMatchTier | undefined;
  if (Object.hasOwn(record, "proposedTier")) {
    if (record.proposedTier !== "exact_patch_body" && record.proposedTier !== "exact_file_set") {
      contractError(`${path}.proposedTier`, "is not a supported match tier");
    }
    proposedTier = record.proposedTier;
  }
  const nextEvaluateAt = Object.hasOwn(record, "nextEvaluateAt")
    ? asTimestamp(record.nextEvaluateAt, `${path}.nextEvaluateAt`)
    : undefined;
  return {
    _id: asString(record._id, `${path}._id`, { max: 256, nonempty: true }),
    repoFullName,
    deadCommitSha: asSha(record.deadCommitSha, `${path}.deadCommitSha`),
    status,
    proposedSha,
    proposedTier,
    signals,
    lastEvaluatedAt: asTimestamp(record.lastEvaluatedAt, `${path}.lastEvaluatedAt`),
    nextEvaluateAt,
  };
}

function parseDecision(value: unknown, path: string): RepairDecision {
  const record = asRecord(value, path);
  assertKeys(record, path, ["_id", "intent", "status", "intentTruncated"], ["shortId"]);
  const status = record.status;
  if (status !== "provisional" && status !== "abandoned") {
    contractError(`${path}.status`, "is not a repairable decision status");
  }
  return {
    _id: asString(record._id, `${path}._id`, { max: 256, nonempty: true }),
    shortId: optionalString(record, "shortId", path, 128),
    intent: asString(record.intent, `${path}.intent`, { max: MAX_INTENT_LENGTH }),
    status,
    intentTruncated: asBoolean(record.intentTruncated, `${path}.intentTruncated`),
  };
}

function parseListItem(value: unknown, path: string): CommitRepairListItem {
  const record = asRecord(value, path);
  assertKeys(record, path, [
    "proposal",
    "decisions",
    "affectedDecisionCount",
    "decisionsTruncated",
    "reviewToken",
  ]);
  if (
    !Array.isArray(record.decisions) ||
    record.decisions.length > MAX_REPAIR_DECISIONS_FOR_CONFIRM
  ) {
    contractError(`${path}.decisions`, "must be a bounded array");
  }
  const decisions = record.decisions.map((decision, index) =>
    parseDecision(decision, `${path}.decisions[${String(index)}]`),
  );
  const proposal = parseProposal(record.proposal, `${path}.proposal`);
  const decisionsTruncated = asBoolean(record.decisionsTruncated, `${path}.decisionsTruncated`);
  const affectedDecisionCount =
    record.affectedDecisionCount === null
      ? null
      : asCount(record.affectedDecisionCount, `${path}.affectedDecisionCount`);
  let reviewToken: string | null;
  if (record.reviewToken === null) {
    reviewToken = null;
  } else {
    reviewToken = asString(record.reviewToken, `${path}.reviewToken`, {
      max: 64,
      nonempty: true,
    });
    if (!REVIEW_TOKEN_RE.test(reviewToken)) {
      contractError(`${path}.reviewToken`, "must be a canonical lowercase SHA-256 token");
    }
  }
  if (!decisionsTruncated && affectedDecisionCount === null) {
    contractError(path, "cannot claim a complete decision list with an unknown count");
  }
  if (!decisionsTruncated && affectedDecisionCount !== decisions.length) {
    contractError(path, "has a complete decision count that does not match its projection");
  }
  if (
    decisionsTruncated &&
    affectedDecisionCount !== null &&
    affectedDecisionCount <= decisions.length
  ) {
    contractError(path, "claims truncation without a larger affected-decision count");
  }
  if (decisionsTruncated && reviewToken !== null) {
    contractError(path, "must not expose a review token for a truncated decision set");
  }
  if (
    reviewToken !== null &&
    (proposal.proposedSha === undefined ||
      proposal.proposedTier === undefined ||
      proposal.proposedSha === proposal.deadCommitSha)
  ) {
    contractError(path, "must not expose a review token without a valid replacement candidate");
  }
  return {
    proposal,
    decisions,
    affectedDecisionCount,
    decisionsTruncated,
    reviewToken,
  };
}

function parseListPage(value: unknown, pageNumber: number): RepairsListPage {
  const path = `page ${String(pageNumber)}`;
  const record = asRecord(value, path);
  assertKeys(record, path, ["repairs", "isDone", "nextCursor", "truncated"]);
  if (!Array.isArray(record.repairs) || record.repairs.length > MAX_REPAIRS_PER_PAGE) {
    contractError(`${path}.repairs`, "must be a bounded array");
  }
  const isDone = asBoolean(record.isDone, `${path}.isDone`);
  const truncated = asBoolean(record.truncated, `${path}.truncated`);
  if (truncated === isDone) contractError(path, "has inconsistent isDone/truncated flags");
  let nextCursor: string | null;
  if (record.nextCursor === null) {
    nextCursor = null;
  } else {
    nextCursor = asString(record.nextCursor, `${path}.nextCursor`, {
      max: MAX_CURSOR_LENGTH,
      nonempty: true,
    });
  }
  if (isDone && nextCursor !== null) contractError(path, "is done but includes a next cursor");
  if (!isDone && nextCursor === null) contractError(path, "is incomplete without a next cursor");
  return {
    repairs: record.repairs.map((item, index) =>
      parseListItem(item, `${path}.repairs[${String(index)}]`),
    ),
    isDone,
    nextCursor,
    truncated,
  };
}

function effectivePageLimit(deps: RepairsDeps): number {
  if (deps.maxPages === undefined) return MAX_REPAIR_LIST_PAGES;
  if (!Number.isSafeInteger(deps.maxPages) || deps.maxPages < 1) {
    throw new RepairListContractError("configured page limit must be a positive safe integer");
  }
  return Math.min(deps.maxPages, MAX_REPAIR_LIST_PAGES);
}

function listPath(cursor: string | null): string {
  if (cursor === null) return "/api/cli/decisions/repairs";
  const search = new URLSearchParams({ cursor });
  return `/api/cli/decisions/repairs?${search.toString()}`;
}

async function fetchRepairsWithClient(
  client: CliClient,
  deps: RepairsDeps,
): Promise<RepairsListResult> {
  const repairs: CommitRepairListItem[] = [];
  const seenCursors = new Set<string>();
  const seenProposalIds = new Set<string>();
  const pageLimit = effectivePageLimit(deps);
  let cursor: string | null = null;

  for (let pageNumber = 1; pageNumber <= pageLimit; pageNumber += 1) {
    let rawPage: unknown;
    try {
      rawPage = await client.get(listPath(cursor), {
        signal: AbortSignal.timeout(REPAIRS_TIMEOUT_MS),
      });
    } catch (error) {
      if (error instanceof HttpError && error.status === 403) {
        throw new RepairAuthorizationError();
      }
      if (error instanceof HttpError && error.status === 404) {
        throw new RepairEndpointVersionError();
      }
      throw error;
    }
    const page = parseListPage(rawPage, pageNumber);
    for (const item of page.repairs) {
      if (seenProposalIds.has(item.proposal._id)) {
        contractError(`page ${String(pageNumber)}`, "repeats a proposal from an earlier page");
      }
      seenProposalIds.add(item.proposal._id);
      repairs.push(item);
    }
    if (page.isDone) {
      return { repairs, isDone: true, nextCursor: null, truncated: false };
    }
    const nextCursor = page.nextCursor;
    if (nextCursor === null)
      contractError(`page ${String(pageNumber)}`, "has no continuation cursor");
    if (nextCursor === cursor || seenCursors.has(nextCursor)) {
      contractError(`page ${String(pageNumber)}`, "has a repeated or non-advancing cursor");
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  throw new RepairListContractError(
    `pagination did not finish within ${String(pageLimit)} page(s); no partial result was emitted`,
  );
}

export async function fetchRepairs(deps: RepairsDeps = defaultDeps): Promise<RepairsListResult> {
  return fetchRepairsWithClient(deps.getClient(), deps);
}

function normalizedResolutionInput(
  proposalId: string,
  expectedProposedSha: string,
): { proposalId: string; expectedProposedSha: string } {
  if (proposalId.length === 0 || proposalId.length > 256) {
    throw new RepairResolutionInputError("proposal ID must be a non-empty bounded string");
  }
  if (!SHA_INPUT_RE.test(expectedProposedSha)) {
    throw new RepairResolutionInputError("expected proposed SHA must be a 40-character Git SHA");
  }
  return { proposalId, expectedProposedSha: expectedProposedSha.toLowerCase() };
}

function parseResolutionOutcome(
  value: unknown,
  action: RepairResolutionAction,
): RepairResolutionOutcome {
  const record = asRecord(value, "resolution response");
  const allowed =
    action === "confirm"
      ? ["confirmed", "already_applied", "disabled", "no_op", "stale"]
      : ["rejected", "already_applied", "no_op", "stale"];
  if (record.status === "backoff") {
    assertKeys(record, "resolution response", ["status", "retryAt"]);
    if (action !== "confirm") {
      contractError("resolution response.status", "backoff is impossible for reject");
    }
    return {
      status: "backoff",
      retryAt: asTimestamp(record.retryAt, "resolution response.retryAt"),
    };
  }
  assertKeys(record, "resolution response", ["status"]);
  if (typeof record.status !== "string" || !allowed.includes(record.status)) {
    contractError("resolution response.status", "is not a supported outcome");
  }
  return { status: record.status as RepairResolutionStatus };
}

function normalizedReviewToken(value: string | undefined): string {
  if (value === undefined || !REVIEW_TOKEN_INPUT_RE.test(value)) {
    throw new RepairResolutionInputError(
      "confirm requires --review-token with the 64-character token from the reviewed list",
    );
  }
  return value.toLowerCase();
}

function parseConflictOutcome(
  value: unknown,
  action: RepairResolutionAction,
): RepairResolutionOutcome {
  const record = asRecord(value, "resolution conflict response");
  assertKeys(record, "resolution conflict response", ["status"]);
  if (action !== "confirm") {
    contractError(
      "resolution conflict response.status",
      "a review conflict is impossible for reject",
    );
  }
  if (record.status !== "review_too_large" && record.status !== "stale_review") {
    contractError("resolution conflict response.status", "is not a supported 409 outcome");
  }
  return { status: record.status };
}

export async function resolveRepair(
  proposalId: string,
  expectedProposedSha: string,
  action: RepairResolutionAction,
  expectedReviewToken?: string,
  deps: RepairsDeps = defaultDeps,
): Promise<RepairResolutionResult> {
  const normalized = normalizedResolutionInput(proposalId, expectedProposedSha);
  const reviewToken = action === "confirm" ? normalizedReviewToken(expectedReviewToken) : undefined;
  if (action === "reject" && expectedReviewToken !== undefined) {
    throw new RepairResolutionInputError("--review-token is valid only with confirm");
  }
  const client = deps.getClient();
  const wireAction = action === "confirm" ? REVIEWED_CONFIRM_WIRE_ACTION : "reject";
  try {
    const rawOutcome = await client.post(
      "/api/cli/decisions/repairs/resolve",
      {
        id: normalized.proposalId,
        action: wireAction,
        expectedProposedSha: normalized.expectedProposedSha,
        ...(reviewToken === undefined ? {} : { expectedReviewToken: reviewToken }),
      },
      { signal: AbortSignal.timeout(REPAIRS_TIMEOUT_MS) },
    );
    return {
      proposalId: normalized.proposalId,
      action,
      outcome: parseResolutionOutcome(rawOutcome, action),
    };
  } catch (error) {
    if (
      error instanceof HttpError &&
      error.status === 404 &&
      error.message === "Repair proposal not found"
    ) {
      throw new RepairProposalNotFoundError(normalized.proposalId);
    }
    if (error instanceof HttpError && error.status === 404) {
      throw new RepairEndpointVersionError();
    }
    if (error instanceof HttpError && error.status === 403) {
      throw new RepairAuthorizationError();
    }
    if (
      action === "confirm" &&
      error instanceof HttpError &&
      error.status === 400 &&
      (error.message === LEGACY_REPAIR_BODY_ERROR ||
        error.message === LEGACY_CONFIRM_PROTOCOL_ERROR)
    ) {
      throw new RepairEndpointVersionError();
    }
    if (error instanceof HttpError && error.status === 409) {
      return {
        proposalId: normalized.proposalId,
        action,
        outcome: parseConflictOutcome(error.body, action),
      };
    }
    throw error;
  }
}

function shortSha(sha: string | undefined): string {
  return sha === undefined ? "(missing)" : sha.slice(0, 12);
}

function tierLabel(tier: CommitRepairMatchTier | undefined): string {
  if (tier === "exact_patch_body") return "exact patch body";
  if (tier === "exact_file_set") return "exact file set";
  return "match tier missing";
}

function oneLine(value: string): string {
  return stripControlChars(value.replace(/\s+/gu, " ")).trim();
}

function timestampLabel(value: number): string {
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime())
    ? String(value)
    : `${timestamp.toISOString()} (${String(value)})`;
}

function reviewLabel(item: CommitRepairListItem): string {
  if (item.affectedDecisionCount === null) {
    return `showing ${String(item.decisions.length)}; total unknown; confirmation disabled`;
  }
  if (item.decisionsTruncated) {
    return `showing ${String(item.decisions.length)} of ${String(item.affectedDecisionCount)}; confirmation disabled`;
  }
  if (item.affectedDecisionCount > MAX_REPAIR_DECISIONS_FOR_CONFIRM) {
    return `${String(item.affectedDecisionCount)} affected; exceeds CLI review limit ${String(MAX_REPAIR_DECISIONS_FOR_CONFIRM)}; confirmation disabled`;
  }
  if (item.affectedDecisionCount === 0) {
    return "0 affected; confirmation disabled";
  }
  return `${String(item.affectedDecisionCount)} affected; complete`;
}

function canRenderConfirm(item: CommitRepairListItem): boolean {
  return (
    item.proposal.proposedSha !== undefined &&
    !item.decisionsTruncated &&
    item.affectedDecisionCount !== null &&
    item.affectedDecisionCount > 0 &&
    item.affectedDecisionCount <= MAX_REPAIR_DECISIONS_FOR_CONFIRM &&
    item.reviewToken !== null
  );
}

function shellArg(value: string): string {
  if (/^[a-zA-Z0-9_./:@%+=,-]+$/u.test(value)) return value;
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function proposalReviewLabel(item: CommitRepairListItem): string {
  if (item.proposal.status === "confirmed") {
    return canRenderConfirm(item)
      ? "already confirmed; a guarded application retry may be requested when eligible"
      : "already confirmed; a guarded retry is currently unavailable";
  }
  if (item.proposal.status === "verification_failed") {
    return canRenderConfirm(item)
      ? "prior verification failed; eligible for a fresh confirmation"
      : "prior verification failed; confirmation is currently unavailable";
  }
  return canRenderConfirm(item)
    ? "awaiting operator review"
    : "awaiting review; confirmation is currently unavailable";
}

export function formatRepairsHuman(result: RepairsListResult): string {
  if (result.repairs.length === 0) {
    return "[prim] decision repairs · 0 review-visible proposals · complete paginated scan";
  }

  const lines = [
    `[prim] decision repairs · ${String(result.repairs.length)} review-visible proposal(s) · complete paginated scan`,
  ];
  for (const item of result.repairs) {
    const { proposal, decisions } = item;
    const renderedProposalId = oneLine(proposal._id);
    lines.push(
      `  ${renderedProposalId} [${proposal.status}] · ${oneLine(proposal.repoFullName)} · ${shortSha(proposal.deadCommitSha)} -> ${shortSha(proposal.proposedSha)} · ${tierLabel(proposal.proposedTier)}`,
      `    review state: ${proposalReviewLabel(item)}`,
    );
    if (proposal.signals.length > 0) {
      lines.push(`    signals: ${proposal.signals.map(oneLine).join("; ")}`);
    }
    if (proposal.nextEvaluateAt !== undefined) {
      lines.push(`    next proposal evaluation: ${timestampLabel(proposal.nextEvaluateAt)}`);
    }
    lines.push(`    decisions (${reviewLabel(item)}):`);
    for (const decision of decisions) {
      const id = renderIdentifier({
        shortId: decision.shortId === undefined ? undefined : oneLine(decision.shortId),
        id: oneLine(decision._id),
      });
      const truncation = decision.intentTruncated ? " [intent truncated]" : "";
      lines.push(`      - ${id} [${decision.status}] ${oneLine(decision.intent)}${truncation}`);
    }
    if (canRenderConfirm(item) && proposal.status === "proposed") {
      lines.push(
        `    confirm: prim decisions repairs confirm ${shellArg(renderedProposalId)} ${proposal.proposedSha} --review-token ${item.reviewToken}`,
      );
    }
    if (canRenderConfirm(item) && proposal.status === "verification_failed") {
      lines.push(
        `    retry verification: prim decisions repairs confirm ${shellArg(renderedProposalId)} ${proposal.proposedSha} --review-token ${item.reviewToken}`,
      );
    }
    if (canRenderConfirm(item) && proposal.status === "confirmed") {
      lines.push(
        `    guarded retry confirmation: prim decisions repairs confirm ${shellArg(renderedProposalId)} ${proposal.proposedSha} --review-token ${item.reviewToken}`,
      );
    }
    if (proposal.proposedSha !== undefined) {
      lines.push(
        `    reject:  prim decisions repairs reject ${shellArg(renderedProposalId)} ${proposal.proposedSha}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatRepairsJson(result: RepairsListResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatRepairResolutionHuman(result: RepairResolutionResult): string {
  const proposalId = oneLine(result.proposalId);
  switch (result.outcome.status) {
    case "confirmed":
      return `[prim] repair ${proposalId} confirmed; fresh landing verification queued. No Decision was changed by this response.`;
    case "rejected":
      return `[prim] repair ${proposalId} rejected.`;
    case "already_applied":
      return `[prim] repair ${proposalId} was already applied; nothing to change.`;
    case "backoff":
      return `[prim] repair ${proposalId} is in application retry backoff; nothing changed. Retry at ${timestampLabel(result.outcome.retryAt)}.`;
    case "disabled":
      return `[prim] repair ${proposalId} was not confirmed because repair application is disabled; nothing changed.`;
    case "review_too_large":
      return `[prim] repair ${proposalId} was refused because its complete review exceeds the safe bound; nothing changed.`;
    case "stale_review":
      return `[prim] repair ${proposalId} changed after review; re-list and review the current decision set before confirming with its new token. Nothing changed.`;
    case "stale":
      return `[prim] repair ${proposalId} has a different proposed SHA; refresh the repair list before acting. Nothing changed.`;
    case "no_op":
      return `[prim] repair ${proposalId} cannot be ${result.action === "confirm" ? "confirmed" : "rejected"} in its current state; nothing changed.`;
  }
}

export function formatRepairResolutionJson(result: RepairResolutionResult): string {
  return JSON.stringify(result.outcome, null, 2);
}
