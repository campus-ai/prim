import { Buffer } from "node:buffer";
import { getClient } from "../client.js";
import type { PreflightResponseV3 } from "../contract/cli-http-v1.js";
import { boundedHealthError } from "../lib/ansi.js";
import { canonicalGitRoot, canonicalRepositoryPath } from "../lib/git.js";
import type { Agent } from "./agent.js";
import { approvalSummary } from "./approval-copy.js";
import { canonicalToolJson } from "./conflict-operation.js";
import {
  type ConflictCheckResult,
  type ConflictVerdict,
  type HookMode,
  demoteForMode,
  extractFileTargets,
} from "./pre-tool-use-scoring.js";
import { DEFAULT_RULES, scrub } from "./redact.js";
import { analyzeShellTargets } from "./shell-targets.js";
export const PREFLIGHT_PROTOCOL_VERSION = 3 as const;
// The server allows a 7.5-second semantic evaluation plus one second for its
// owner to finalize. Leave one additional second for the response to reach
// the hook before failing open visibly.
export const PREFLIGHT_TIMEOUT_MS = 6_500;
export const MAX_PREFLIGHT_PATHS = 32;
export const MAX_PROPOSAL_BYTES = 6_144;
export const MAX_CLIENT_VERSION_CHARS = 32;
const CLIENT_VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const MAX_DECISION_DISCLOSURES = 16;
const DISCLOSED_DECISION_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const DISCLOSED_DECISION_SHORT_ID_RE = /^[0-9a-f]{8}$/u;

/**
 * Bound the client version to the server's validated token — at most 32
 * characters of its safe charset — or fall back to "unknown". The server
 * degrades an out-of-contract clientVersion to an absent annotation rather
 * than 400ing the request, so this only keeps the correlation field clean;
 * it can never affect whether the enforcement check runs.
 */
export function boundedClientVersion(raw: string | null | undefined): string {
  return typeof raw === "string" &&
    raw.length <= MAX_CLIENT_VERSION_CHARS &&
    CLIENT_VERSION_RE.test(raw)
    ? raw
    : "unknown";
}

export type Coverage = "complete" | "unverified";
export type PreflightClientMode = "block" | "warn";
// biome-ignore format: keep the small wire contract compact
export type PreflightRequest = { protocolVersion: typeof PREFLIGHT_PROTOCOL_VERSION; agent: Agent; clientMode: PreflightClientMode; clientVersion: string; sessionId: string; invocationId: string; repoSyncId: string; paths: string[]; coverage: Coverage; branch?: string; proposal: string; toolName?: string; toolInputDigest?: string; enforcementCapabilities?: {strictPolicy: true; nativeReview: boolean} };
// Additive working-tree V3 extension. The published contract and provenance
// remain pinned until the backend change has a committed release identity.
export type PreflightPolicy = {
  mode: "strict" | "legacy";
  revision: number;
  minimum: "none" | "review" | "deny";
  compatibility: "supported" | "upgrade_required";
};
export type PreflightResponse = PreflightResponseV3 & {
  policy?: PreflightPolicy;
  reviewUrl?: string;
  operationId?: string;
};
// biome-ignore format: compact internal shapes keep this boundary auditable
export type TargetResolution = {
  paths: string[];
  coverage: Coverage;
  mutation: "none" | "present";
  definite?: true;
};
// biome-ignore format: compact internal shapes keep this boundary auditable
type TargetArgs = { toolName: string; toolInput: unknown; agent: Agent; cwd: string };
export function resolvePreflightTargets(args: TargetArgs): TargetResolution {
  let rawPaths: string[];
  let coverage: Coverage = "complete";
  let mutation: "none" | "present" = "present";
  let definite = false;
  const shellTool =
    ((args.agent === "claude_code" || args.agent === "codex") && args.toolName === "Bash") ||
    (args.agent === "cursor" && args.toolName === "Shell");
  if (shellTool) {
    const command =
      typeof args.toolInput === "string"
        ? args.toolInput
        : args.toolInput && typeof args.toolInput === "object"
          ? (args.toolInput as Record<string, unknown>).command
          : undefined;
    if (typeof command !== "string") {
      return { paths: [], coverage: "unverified", mutation: "present" };
    }
    const shell = analyzeShellTargets(command);
    rawPaths = shell.paths;
    coverage = shell.coverage;
    mutation = shell.mutation;
    definite = shell.definiteEdit === true;
  } else {
    const extracted = extractFileTargets(args.toolName, args.toolInput, args.agent);
    if (!extracted) return { paths: [], coverage: "complete", mutation: "none" };
    rawPaths = extracted.paths;
    if (!extracted.complete) coverage = "unverified";
    definite = true;
  }
  const root = canonicalGitRoot(args.cwd);
  const paths = new Set<string>();
  for (const rawPath of rawPaths) {
    const canonical = canonicalRepositoryPath(rawPath, args.cwd, root);
    if (canonical) paths.add(canonical);
    else coverage = "unverified";
  }
  const bounded = [...paths];
  if (bounded.length > MAX_PREFLIGHT_PATHS) coverage = "unverified";
  const resolved = bounded.slice(0, MAX_PREFLIGHT_PATHS);
  if (definite && resolved.length === 0 && mutation === "present") {
    return { paths: resolved, coverage: "unverified", mutation, definite: true };
  }
  return { paths: resolved, coverage, mutation };
}
function truncateUtf8(value: string, maxBytes: number): string {
  const encoded = Buffer.from(value);
  if (encoded.byteLength <= maxBytes) return value;
  return encoded
    .subarray(0, maxBytes)
    .toString("utf8")
    .replace(/\uFFFD$/u, "");
}
export function proposalFor(toolInput: unknown): string {
  const redacted = scrub(toolInput, DEFAULT_RULES);
  return truncateUtf8(canonicalToolJson(redacted), MAX_PROPOSAL_BYTES);
}
export function parsePreflightResponse(value: unknown): PreflightResponse | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const response = value as Record<string, unknown>;
  const verdicts = new Set(["allow", "warn", "ask", "block", "unavailable"]);
  if (
    response.protocolVersion !== PREFLIGHT_PROTOCOL_VERSION ||
    typeof response.verdict !== "string" ||
    !verdicts.has(response.verdict) ||
    typeof response.reasonCode !== "string" ||
    typeof response.message !== "string" ||
    !Array.isArray(response.conflicts) ||
    !Array.isArray(response.bypassed)
  ) {
    return null;
  }
  if (
    response.checkId !== undefined &&
    (typeof response.checkId !== "string" || !DISCLOSED_DECISION_ID_RE.test(response.checkId))
  )
    return null;
  if (response.policy !== undefined && !validPolicy(response.policy)) return null;
  if (response.reviewUrl !== undefined && !validReviewUrl(response.reviewUrl)) return null;
  if (
    response.operationId !== undefined &&
    (typeof response.operationId !== "string" || !/^[a-f0-9]{64}$/u.test(response.operationId))
  )
    return null;
  const disclosures = response.decisionDisclosures;
  if (disclosures !== undefined) {
    if (
      !Array.isArray(disclosures) ||
      disclosures.length === 0 ||
      disclosures.length > MAX_DECISION_DISCLOSURES
    ) {
      return null;
    }
    const seen = new Set<string>();
    for (const value of disclosures) {
      if (!value || typeof value !== "object" || Array.isArray(value)) return null;
      const disclosure = value as Record<string, unknown>;
      if (
        Object.keys(disclosure).length !== 3 ||
        !Object.hasOwn(disclosure, "decisionId") ||
        !Object.hasOwn(disclosure, "shortId") ||
        !Object.hasOwn(disclosure, "participation") ||
        typeof disclosure.decisionId !== "string" ||
        !DISCLOSED_DECISION_ID_RE.test(disclosure.decisionId) ||
        typeof disclosure.shortId !== "string" ||
        !DISCLOSED_DECISION_SHORT_ID_RE.test(disclosure.shortId) ||
        (disclosure.participation !== "candidate" &&
          disclosure.participation !== "reconcile_bypass") ||
        seen.has(disclosure.decisionId)
      ) {
        return null;
      }
      seen.add(disclosure.decisionId);
    }
  }
  return response as unknown as PreflightResponse;
}

function validPolicy(value: unknown): value is PreflightPolicy {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const policy = value as Record<string, unknown>;
  return (
    (policy.mode === "strict" || policy.mode === "legacy") &&
    Number.isSafeInteger(policy.revision) &&
    (policy.revision as number) >= 0 &&
    ["none", "review", "deny"].includes(policy.minimum as string) &&
    ["supported", "upgrade_required"].includes(policy.compatibility as string)
  );
}

function validReviewUrl(value: unknown): value is string {
  if (typeof value !== "string" || value.length > 2048 || /[^\x21-\x7e]/u.test(value)) return false;
  try {
    const url = new URL(value);
    return (
      !url.username &&
      !url.password &&
      !url.hash &&
      !url.search &&
      (url.protocol === "https:" ||
        (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      /^\/reviews\/[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(url.pathname)
    );
  } catch {
    return false;
  }
}

/** Apply organization authority after the local display preference. */
export function effectivePreflightVerdict(
  response: PreflightResponse,
  mode: HookMode,
  nativeReview: boolean,
): ConflictVerdict {
  const declared =
    response.verdict === "block"
      ? "deny"
      : response.verdict === "unavailable"
        ? "allow"
        : response.verdict;
  const preferred = demoteForMode(declared, mode);
  if (response.policy?.mode !== "strict") return preferred;
  if (response.policy.minimum === "deny") return "deny";
  if (response.policy.minimum === "review") {
    return response.verdict === "block" || !nativeReview ? "deny" : "ask";
  }
  // A strict server block/ask must remain effective even when an older or
  // inconsistent response omitted its more specific minimum.
  if (declared === "deny") return "deny";
  if (declared === "ask") return nativeReview ? "ask" : "deny";
  return preferred;
}

/** Render only a bounded, terminal-safe lookup command for each hidden row. */
export function decisionDisclosureContext(response: PreflightResponse): string {
  return (
    response.decisionDisclosures
      ?.map(({ decisionId }) => `[primitive] hidden Decision: prim decisions show ${decisionId}`)
      .join("\n") ?? ""
  );
}
export async function requestPreflight(
  request: PreflightRequest,
  signal: AbortSignal = AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
): Promise<PreflightResponse | null> {
  const response = await getClient().post("/api/cli/decisions/conflict-check", request, {
    signal,
    quietRefresh: true,
  });
  return parsePreflightResponse(response);
}
export function resultForPreflight(
  response: PreflightResponse,
  preview = "Review the requested change.",
): ConflictCheckResult {
  const verdict = response.verdict === "block" ? "deny" : response.verdict;
  // The wire response remains untouched for protocol compatibility. These
  // values cross into terminal and hook presentation, so normalize them once
  // at the mapping boundary before any host-specific renderer can consume them.
  const message = boundedHealthError(response.message) ?? "";
  const unavailable = message || boundedHealthError(response.reasonCode);
  const safe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  const directives =
    response.policy?.mode === "strict"
      ? [
          ...(response.reviewUrl ? [`Human review: ${response.reviewUrl}`] : []),
          ...(response.operationId ? [`Operation: ${response.operationId}`] : []),
          ...(["ask", "block"].includes(response.verdict) || response.policy.minimum !== "none"
            ? [
                "Review this exact change before retrying. Browser approval lasts five minutes and can be used once. Legacy bypasses do not authorize strict conflicts.",
              ]
            : []),
        ]
      : response.conflicts.flatMap((value) => {
          if (!value || typeof value !== "object") return [];
          const { decisionId, shortId } = value as Record<string, unknown>;
          const id =
            typeof shortId === "string" && safe.test(shortId)
              ? `dec_${shortId}`
              : typeof decisionId === "string" && safe.test(decisionId)
                ? decisionId
                : undefined;
          if (!id) return [];
          return [
            `To reconcile, run: prim reconcile ${id}`,
            ...(response.checkId && safe.test(response.checkId)
              ? [
                  `Check: ${response.checkId}. After resolving, record the confirmed outcome: prim reconcile ${id} --check ${response.checkId} --outcome followed (retained Decision), or --outcome superseded (after replacing it). A bypass alone is not a resolution.`,
                ]
              : []),
          ];
        });
  const compatibilityNotice =
    response.policy?.compatibility === "upgrade_required"
      ? "[primitive] upgrade required: this hook runtime cannot verify strict enforcement. Update Primitive and reinstall this agent integration."
      : "";
  const guidance = [message, ...new Set(directives), compatibilityNotice]
    .filter(Boolean)
    .join("\n");
  const reason =
    response.conflicts.length > 0 ||
    response.verdict === "ask" ||
    response.verdict === "block" ||
    response.policy?.minimum === "review" ||
    response.policy?.minimum === "deny"
      ? approvalSummary(
          {
            conflicts: response.conflicts,
            message,
            reasonCode: response.reasonCode,
            evaluationCoverage: response.evaluationCoverage as
              | { status?: unknown; selectionOmissions?: unknown; evidenceOmissions?: unknown }
              | undefined,
          },
          preview,
        )
      : message;
  const disclosureContext = decisionDisclosureContext(response);
  return {
    verdict,
    conflicts: response.conflicts,
    reason,
    additionalContext: [
      disclosureContext,
      compatibilityNotice,
      ["warn", "ask", "block"].includes(response.verdict) ? guidance : "",
    ]
      .filter(Boolean)
      .join("\n"),
    truncated: false,
    unavailable: response.verdict === "unavailable" ? unavailable : undefined,
  };
}
export function unverifiedResult(message: string): ConflictCheckResult {
  return {
    verdict: "unavailable",
    conflicts: [],
    reason: "",
    additionalContext: "",
    truncated: false,
    unavailable: message,
  };
}
