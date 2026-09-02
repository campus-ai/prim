import { Buffer } from "node:buffer";
import { getClient } from "../client.js";
import type { PreflightResponseV3 } from "../contract/cli-http-v1.js";
import { boundedHealthError } from "../lib/ansi.js";
import { canonicalGitRoot, canonicalRepositoryPath } from "../lib/git.js";
import type { Agent } from "./agent.js";
import { type ConflictCheckResult, extractFileTargets } from "./pre-tool-use-scoring.js";
import { DEFAULT_RULES, scrub } from "./redact.js";
import { analyzeShellTargets } from "./shell-targets.js";
export const PREFLIGHT_PROTOCOL_VERSION = 3 as const;
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
export type PreflightRequest = { protocolVersion: typeof PREFLIGHT_PROTOCOL_VERSION; agent: Agent; clientMode: PreflightClientMode; clientVersion: string; sessionId: string; invocationId: string; repoSyncId: string; paths: string[]; coverage: Coverage; proposal: string };
export type PreflightResponse = PreflightResponseV3;
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
  if ((args.agent === "claude_code" || args.agent === "codex") && args.toolName === "Bash") {
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
  return truncateUtf8(JSON.stringify(redacted) ?? "", MAX_PROPOSAL_BYTES);
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
export function resultForPreflight(response: PreflightResponse): ConflictCheckResult {
  const verdict = response.verdict === "block" ? "deny" : response.verdict;
  // The wire response remains untouched for protocol compatibility. These
  // values cross into terminal and hook presentation, so normalize them once
  // at the mapping boundary before any host-specific renderer can consume them.
  const message = boundedHealthError(response.message) ?? "";
  const unavailable = message || boundedHealthError(response.reasonCode);
  const safe = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
  const directives = response.conflicts.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const { decisionId, shortId } = value as Record<string, unknown>;
    const id =
      typeof shortId === "string" && safe.test(shortId)
        ? `dec_${shortId}`
        : typeof decisionId === "string" && safe.test(decisionId)
          ? decisionId
          : undefined;
    return id ? [`To reconcile, run: prim reconcile ${id}`] : [];
  });
  const reason = [message, ...new Set(directives)].filter(Boolean).join("\n");
  const disclosureContext = decisionDisclosureContext(response);
  return {
    verdict,
    conflicts: response.conflicts,
    reason,
    additionalContext:
      disclosureContext || (["warn", "ask", "block"].includes(response.verdict) ? reason : ""),
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
