import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { getClient } from "../client.js";
import { isPreflightResponseV4 } from "../contract/cli-http-v1.js";
import { boundedHealthError } from "../lib/ansi.js";
import type { ConflictCheckResult } from "./pre-tool-use-scoring.js";
import {
  type PreflightRequest as PreflightRequestV3,
  type PreflightResponse as PreflightResponseV3,
  parsePreflightResponse as parseV3Presentation,
  resultForPreflight as renderCompleted,
} from "./preflight-v3.js";

export const PREFLIGHT_PROTOCOL_VERSION = 4 as const;
export const PREFLIGHT_WAIT_MS = 240_000;
export const PREFLIGHT_REQUEST_MS = 10_000;
const ENDPOINT = "/api/cli/decisions/conflict-check";
const SAFE_ID = /^[A-Za-z0-9]{1,64}$/u;
const STATES = new Set(["processing", "completed", "paused", "expired"]);
const COVERAGE_STATUSES = new Set(["completed", "partial", "unavailable", "not_run", "unknown"]);

export type PreflightRequest = Omit<PreflightRequestV3, "protocolVersion"> & {
  protocolVersion: 4;
  operation: "start";
  toolInputDigest: string;
};
export type PreflightOperation =
  | PreflightRequest
  | {
      protocolVersion: 4;
      operation: "status" | "resume";
      checkId: string;
    };
export type EvaluationCoverage = {
  candidateCount: number;
  submittedCount: number;
  evaluatedCount: number;
  bypassedCount: number;
  discoveryComplete: boolean;
  status: "completed" | "partial" | "unavailable" | "not_run" | "unknown";
  semanticBatchCount: number;
  completedSemanticBatchCount: number;
};
export type PreflightResponse = Pick<
  PreflightResponseV3,
  | "verdict"
  | "reasonCode"
  | "message"
  | "conflicts"
  | "bypassed"
  | "checkId"
  | "decisionDisclosures"
> & {
  protocolVersion: 4;
  state: "processing" | "completed" | "paused" | "expired";
  evaluationId?: string;
  evaluationCoverage: EvaluationCoverage;
  retryAfterMs?: number;
};

/** Identity uses the entire input, before redaction or proposal truncation. */
export function toolInputDigest(toolName: string, input: unknown): string {
  function canonical(value: unknown, depth = 0): string {
    if (depth > 100) throw new Error("Tool input exceeds the identity nesting limit");
    if (value === null || typeof value === "string" || typeof value === "boolean") {
      return JSON.stringify(value);
    }
    if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
    if (Array.isArray(value))
      return `[${value.map((item) => canonical(item, depth + 1)).join(",")}]`;
    if (typeof value === "object" && value !== null) {
      return `{${Object.entries(value)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item, depth + 1)}`)
        .join(",")}}`;
    }
    throw new Error("Tool input has no stable JSON identity");
  }
  return createHash("sha256")
    .update(canonical({ toolName, input: input ?? null }))
    .digest("hex");
}

/** Pre-admission failures have no persisted check or evaluation to identify. */
function isUnidentifiedPause(response: {
  state?: unknown;
  verdict?: unknown;
  checkId?: unknown;
  evaluationId?: unknown;
}): boolean {
  return (
    response.state === "paused" &&
    (response.verdict === "block" || response.verdict === "unavailable") &&
    response.checkId === undefined &&
    response.evaluationId === undefined
  );
}

export function parsePreflightResponse(value: unknown): PreflightResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  if (!isPreflightResponseV4(response)) return null;
  // Reuse only the existing presentation validation, never its transport.
  if (response.protocolVersion !== 4 || !parseV3Presentation({ ...response, protocolVersion: 3 }))
    return null;
  if (typeof response.state !== "string" || !STATES.has(response.state)) return null;
  for (const key of ["checkId", "evaluationId"]) {
    if (
      response[key] !== undefined &&
      (typeof response[key] !== "string" || !SAFE_ID.test(response[key] as string))
    )
      return null;
  }
  if (
    !isUnidentifiedPause(response) &&
    !(
      response.state === "completed" &&
      (response.reasonCode === "enforcement_disabled" ||
        response.reasonCode === "no_targets_skipped")
    ) &&
    (!response.checkId || !response.evaluationId)
  )
    return null;
  if (
    response.retryAfterMs !== undefined &&
    (!Number.isSafeInteger(response.retryAfterMs) || (response.retryAfterMs as number) < 0)
  )
    return null;
  const coverage = response.evaluationCoverage;
  if (!coverage || typeof coverage !== "object" || Array.isArray(coverage)) return null;
  const counts = coverage as Record<string, unknown>;
  for (const key of [
    "candidateCount",
    "submittedCount",
    "evaluatedCount",
    "bypassedCount",
    "semanticBatchCount",
    "completedSemanticBatchCount",
  ]) {
    if (!Number.isSafeInteger(counts[key]) || (counts[key] as number) < 0) return null;
  }
  if (
    typeof counts.discoveryComplete !== "boolean" ||
    typeof counts.status !== "string" ||
    !COVERAGE_STATUSES.has(counts.status)
  )
    return null;
  if (
    (counts.evaluatedCount as number) > (counts.submittedCount as number) ||
    (counts.completedSemanticBatchCount as number) > (counts.semanticBatchCount as number)
  )
    return null;
  return response as unknown as PreflightResponse;
}

export function hasCompleteCoverage(response: PreflightResponse): boolean {
  if (response.state !== "completed" || response.verdict === "unavailable") return false;
  const coverage = response.evaluationCoverage;
  if (response.reasonCode === "enforcement_disabled") {
    return (
      response.verdict === "allow" &&
      coverage.status === "not_run" &&
      coverage.candidateCount === 0 &&
      coverage.submittedCount === 0 &&
      coverage.evaluatedCount === 0 &&
      coverage.bypassedCount === 0 &&
      coverage.semanticBatchCount === 0 &&
      coverage.completedSemanticBatchCount === 0
    );
  }
  return (
    coverage.status === "completed" &&
    coverage.discoveryComplete &&
    coverage.candidateCount === coverage.evaluatedCount + coverage.bypassedCount &&
    coverage.submittedCount === coverage.evaluatedCount &&
    coverage.semanticBatchCount === coverage.completedSemanticBatchCount
  );
}

function isNoTargetsSkip(response: PreflightResponse): boolean {
  const coverage = response.evaluationCoverage;
  return (
    response.state === "completed" &&
    response.verdict === "allow" &&
    response.reasonCode === "no_targets_skipped" &&
    response.checkId === undefined &&
    response.evaluationId === undefined &&
    response.conflicts.length === 0 &&
    response.bypassed.length === 0 &&
    coverage.status === "completed" &&
    coverage.discoveryComplete &&
    coverage.candidateCount === 0 &&
    coverage.submittedCount === 0 &&
    coverage.evaluatedCount === 0 &&
    coverage.bypassedCount === 0 &&
    coverage.semanticBatchCount === 0 &&
    coverage.completedSemanticBatchCount === 0
  );
}

export class PreflightPausedError extends Error {
  constructor(
    message: string,
    readonly checkId?: string,
  ) {
    super(message);
  }
}

export function pausedResult(message: string, checkId?: string): ConflictCheckResult {
  const detail = boundedHealthError(message) ?? "Decision evaluation is incomplete";
  const recovery =
    checkId && SAFE_ID.test(checkId)
      ? `Run: prim decisions preflight resume ${checkId}; then retry the tool call.`
      : "Retry the tool call after restoring the Decision enforcement service.";
  const reason = `[primitive] Operation paused: ${detail}. ${recovery}`;
  return { verdict: "deny", conflicts: [], reason, additionalContext: reason, truncated: false };
}

export function resultForPreflight(
  response: PreflightResponse,
  preview?: string,
): ConflictCheckResult {
  if (!hasCompleteCoverage(response))
    return pausedResult(response.message || response.reasonCode, response.checkId);
  return renderCompleted(
    {
      protocolVersion: 3,
      verdict: response.verdict,
      reasonCode: response.reasonCode,
      message: response.message,
      conflicts: response.conflicts,
      bypassed: response.bypassed,
      checkId: response.checkId,
      decisionDisclosures: response.decisionDisclosures,
      evaluationCoverage: {
        ...response.evaluationCoverage,
        selectionOmissions: [],
        evidenceOmissions: [],
      },
    },
    preview,
  );
}

export async function requestPreflight(
  operation: PreflightOperation,
  deadline = performance.now() + PREFLIGHT_WAIT_MS,
): Promise<PreflightResponse> {
  if (operation.operation !== "start" && !SAFE_ID.test(operation.checkId))
    throw new PreflightPausedError("Invalid check identity");
  const remaining = deadline - performance.now();
  if (remaining <= 0)
    throw new PreflightPausedError(
      "The 240-second check wait expired",
      operation.operation === "start" ? undefined : operation.checkId,
    );
  const value = await getClient().post(ENDPOINT, operation, {
    signal: AbortSignal.timeout(Math.max(1, Math.ceil(Math.min(PREFLIGHT_REQUEST_MS, remaining)))),
    quietRefresh: true,
  });
  if (performance.now() >= deadline)
    throw new PreflightPausedError(
      "The 240-second check wait expired",
      operation.operation === "start" ? undefined : operation.checkId,
    );
  const response = parsePreflightResponse(value);
  if (!response)
    throw new PreflightPausedError(
      "The enforcement service returned an incompatible V4 response",
      operation.operation === "start" ? undefined : operation.checkId,
    );
  if (
    response.reasonCode === "no_targets_skipped" &&
    !(
      operation.operation === "start" &&
      operation.paths.length === 0 &&
      operation.coverage === "unverified" &&
      isNoTargetsSkip(response)
    )
  ) {
    throw new PreflightPausedError(
      "The enforcement service returned an invalid target-policy exemption",
      operation.operation === "start" ? undefined : operation.checkId,
    );
  }
  if (
    operation.operation !== "start" &&
    response.checkId !== operation.checkId &&
    !isUnidentifiedPause(response) &&
    !(response.reasonCode === "enforcement_disabled" && hasCompleteCoverage(response))
  )
    throw new PreflightPausedError(
      "The enforcement service returned a different check identity",
      operation.checkId,
    );
  return response;
}

/** The deadline bounds the whole wait, including all requests and polling delays. */
export async function waitForPreflight(
  operation: PreflightOperation,
  options: { deadline?: number; onProgress?: (response: PreflightResponse) => void } = {},
): Promise<PreflightResponse> {
  const deadline = options.deadline ?? performance.now() + PREFLIGHT_WAIT_MS;
  let next = operation;
  let evaluationId: string | undefined;
  let lastProgress: string | undefined;
  let checkId = operation.operation === "start" ? undefined : operation.checkId;
  while (true) {
    let response: PreflightResponse;
    try {
      response = await requestPreflight(next, deadline);
    } catch (error) {
      if (error instanceof PreflightPausedError) throw error;
      if (performance.now() >= deadline)
        throw new PreflightPausedError("The 240-second check wait expired", checkId);
      // Retain the attempt identity for actionable recovery after a failed poll.
      if (checkId)
        throw new PreflightPausedError(
          "The enforcement service could not finish this check",
          checkId,
        );
      throw error;
    }
    if (isUnidentifiedPause(response)) {
      if (checkId) throw new PreflightPausedError(response.message || response.reasonCode, checkId);
      return response;
    }
    if (
      evaluationId &&
      response.evaluationId !== evaluationId &&
      !(response.reasonCode === "enforcement_disabled" && hasCompleteCoverage(response))
    )
      throw new PreflightPausedError(
        "The enforcement service changed evaluation identity",
        checkId,
      );
    checkId = response.checkId;
    evaluationId = response.evaluationId;
    if (response.state !== "processing") return response;
    const progress = JSON.stringify(response.evaluationCoverage);
    if (progress !== lastProgress) options.onProgress?.(response);
    lastProgress = progress;
    const remaining = deadline - performance.now();
    if (remaining <= 0)
      throw new PreflightPausedError("The 240-second check wait expired", checkId);
    await delay(
      Math.min(remaining, Math.max(100, Math.min(5_000, response.retryAfterMs ?? 1_000))),
    );
    next = { protocolVersion: 4, operation: "status", checkId: checkId as string };
  }
}
