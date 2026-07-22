import { Buffer } from "node:buffer";
import { getClient } from "../client.js";
import { canonicalGitRoot, canonicalRepositoryPath } from "../lib/git.js";
import type { Agent } from "./agent.js";
import { type ConflictCheckResult, extractFileTargets } from "./pre-tool-use-scoring.js";
import { DEFAULT_RULES, scrub } from "./redact.js";
import { analyzeShellTargets } from "./shell-targets.js";
export const PREFLIGHT_PROTOCOL_VERSION = 3 as const;
export const PREFLIGHT_TIMEOUT_MS = 4_500;
export const MAX_PREFLIGHT_PATHS = 32;
export const MAX_PROPOSAL_BYTES = 6_144;
export type Coverage = "complete" | "unverified";
// biome-ignore format: keep the small wire contract compact
export type PreflightRequest = { protocolVersion: typeof PREFLIGHT_PROTOCOL_VERSION; agent: Agent; sessionId: string; invocationId: string; repoSyncId: string; paths: string[]; coverage: Coverage; proposal: string };
// biome-ignore format: keep the small wire contract compact
export type PreflightResponse = { protocolVersion: typeof PREFLIGHT_PROTOCOL_VERSION; verdict: "allow" | "warn" | "ask" | "block" | "unavailable"; reasonCode: string; message: string; conflicts: unknown[]; bypassed: unknown[] };
// biome-ignore format: compact internal shapes keep this boundary auditable
export type TargetResolution = { paths: string[]; coverage: Coverage; mutation: "none" | "present" };
// biome-ignore format: compact internal shapes keep this boundary auditable
type TargetArgs = { toolName: string; toolInput: unknown; agent: Agent; cwd: string };
export function resolvePreflightTargets(args: TargetArgs): TargetResolution {
  let rawPaths: string[];
  let coverage: Coverage = "complete";
  let mutation: "none" | "present" = "present";
  if (args.agent === "claude_code" && args.toolName === "Bash") {
    const command =
      args.toolInput && typeof args.toolInput === "object"
        ? (args.toolInput as Record<string, unknown>).command
        : undefined;
    if (typeof command !== "string") {
      return { paths: [], coverage: "unverified", mutation: "present" };
    }
    const shell = analyzeShellTargets(command);
    rawPaths = shell.paths;
    coverage = shell.coverage;
    mutation = shell.mutation;
  } else {
    const extracted = extractFileTargets(args.toolName, args.toolInput, args.agent);
    if (!extracted) return { paths: [], coverage: "complete", mutation: "none" };
    rawPaths = extracted.paths;
    if (!extracted.complete) coverage = "unverified";
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
  return { paths: bounded.slice(0, MAX_PREFLIGHT_PATHS), coverage, mutation };
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
  return response as PreflightResponse;
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
  const reason = [response.message, ...new Set(directives)].filter(Boolean).join("\n");
  return {
    verdict,
    conflicts: response.conflicts,
    reason,
    additionalContext: ["warn", "ask", "block"].includes(response.verdict) ? reason : "",
    truncated: false,
    unavailable:
      response.verdict === "unavailable" ? response.message || response.reasonCode : undefined,
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
