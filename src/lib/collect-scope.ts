/**
 * Per-clone collection-scope cache and admission policy.
 *
 * Collection controls whether a move may leave this machine. It is separate
 * from the enforcement gate: an unavailable or never-fetched policy remains
 * universal for compatibility, while malformed cached policy fails closed.
 */

import { type CliClient, getClient } from "../client.js";
import {
  type DecisionCollectScopeResponse,
  isDecisionCollectScopeResponse,
} from "../contract/cli-http-v1.js";
import { localGitConfigValue, setLocalGitConfigValue } from "./activation.js";
import { isScopeDirectoryPrefix, matchesScopeGlob } from "./scope-glob.js";

export const PRIM_COLLECT_SCOPE_KEY = "prim.collectScope";
export const PRIM_COLLECT_SCOPE_VERSION_KEY = "prim.collectScopeVersion";
export const COLLECT_SCOPE_TIMEOUT_MS = 1_000;
const COLLECT_SCOPE_PATH = "/api/cli/decisions/collect-scope";
const MAX_BRANCH_PATTERN_CHARS = 255;

export interface CollectScopePolicy {
  repositories?: string[];
  directories?: string[];
  globs?: string[];
  branches?: string[];
  /** Inclusive client-clock instant at which collection begins. */
  effectiveFrom?: number;
  /** Exclusive client-clock instant at which collection stops. */
  effectiveUntil?: number;
  updatedAt: number;
}

export interface CollectScopeFacts {
  /** GitHub owner/repository name, when the local checkout has one. */
  repository?: string;
  /** Checked-out Git branch, absent for detached or non-Git worktrees. */
  branch?: string;
  /** Omit for intentionally path-less events such as session Stop/rewrite. */
  paths?: readonly string[];
  /** Required when `paths` is supplied and a path policy exists. */
  pathsComplete?: boolean;
  /** Local hook clock; injectable only to make boundary behavior deterministic. */
  now?: number;
}

export type CachedCollectScope =
  | { kind: "unfetched" }
  | { kind: "invalid" }
  | { kind: "none"; version: number }
  | { kind: "policy"; policy: CollectScopePolicy; version: number };

export interface CollectScopeDependencies {
  getClient: () => CliClient;
  signal: () => AbortSignal;
  writeCached: (cwd: string, response: DecisionCollectScopeResponse) => CachedCollectScope;
}

const defaultDependencies: CollectScopeDependencies = {
  getClient,
  signal: () => AbortSignal.timeout(COLLECT_SCOPE_TIMEOUT_MS),
  writeCached: writeCachedCollectScope,
};

function isSafeVersion(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function optionalStringArray(
  record: Record<string, unknown>,
  key: "repositories" | "directories" | "globs" | "branches",
): string[] | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) return undefined;
  return [...value];
}

function optionalSafeInteger(
  record: Record<string, unknown>,
  key: "effectiveFrom" | "effectiveUntil",
): number | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  return typeof value === "number" && Number.isSafeInteger(value) ? value : undefined;
}

function policyFromUnknown(value: unknown): CollectScopePolicy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!isSafeVersion(record.updatedAt)) return undefined;
  const fields = {
    repositories: optionalStringArray(record, "repositories"),
    directories: optionalStringArray(record, "directories"),
    globs: optionalStringArray(record, "globs"),
    branches: optionalStringArray(record, "branches"),
    effectiveFrom: optionalSafeInteger(record, "effectiveFrom"),
    effectiveUntil: optionalSafeInteger(record, "effectiveUntil"),
  };
  if (
    Object.entries(fields).some(
      ([key, parsed]) => record[key] !== undefined && parsed === undefined,
    )
  ) {
    return undefined;
  }
  if (
    (record.effectiveFrom !== undefined && fields.effectiveFrom === undefined) ||
    (record.effectiveUntil !== undefined && fields.effectiveUntil === undefined) ||
    (fields.effectiveFrom !== undefined &&
      fields.effectiveUntil !== undefined &&
      fields.effectiveFrom >= fields.effectiveUntil)
  ) {
    return undefined;
  }
  return {
    updatedAt: record.updatedAt,
    ...(fields.repositories === undefined ? {} : { repositories: fields.repositories }),
    ...(fields.directories === undefined ? {} : { directories: fields.directories }),
    ...(fields.globs === undefined ? {} : { globs: fields.globs }),
    ...(fields.branches === undefined ? {} : { branches: fields.branches }),
    ...(fields.effectiveFrom === undefined ? {} : { effectiveFrom: fields.effectiveFrom }),
    ...(fields.effectiveUntil === undefined ? {} : { effectiveUntil: fields.effectiveUntil }),
  };
}

function projectPolicy(
  policy: NonNullable<DecisionCollectScopeResponse["policy"]>,
): CollectScopePolicy {
  const projected = policyFromUnknown(policy);
  if (projected === undefined) throw new Error("invalid collection scope policy");
  return projected;
}

/** Read the last server-issued collection policy saved in local Git config. */
export function readCachedCollectScope(cwd: string): CachedCollectScope {
  const rawPolicy = localGitConfigValue(cwd, PRIM_COLLECT_SCOPE_KEY);
  const rawVersion = localGitConfigValue(cwd, PRIM_COLLECT_SCOPE_VERSION_KEY);
  if (rawPolicy === undefined) {
    return rawVersion === undefined ? { kind: "unfetched" } : { kind: "invalid" };
  }
  const version = rawVersion === undefined ? Number.NaN : Number(rawVersion);
  if (!isSafeVersion(version) || String(version) !== rawVersion) return { kind: "invalid" };
  if (rawPolicy === "none") return { kind: "none", version };

  try {
    const policy = policyFromUnknown(JSON.parse(rawPolicy) as unknown);
    return policy === undefined || policy.updatedAt !== version
      ? { kind: "invalid" }
      : { kind: "policy", policy, version };
  } catch {
    return { kind: "invalid" };
  }
}

/** Persist one validated policy before its version so partial writes fail closed. */
export function writeCachedCollectScope(
  cwd: string,
  response: DecisionCollectScopeResponse,
): CachedCollectScope {
  const policy = response.policy === null ? undefined : projectPolicy(response.policy);
  if (policy !== undefined && policy.updatedAt !== response.collectScopeVersion) {
    throw new Error("collection scope response version did not match its policy");
  }
  setLocalGitConfigValue(
    cwd,
    PRIM_COLLECT_SCOPE_KEY,
    policy === undefined ? "none" : JSON.stringify(policy),
  );
  setLocalGitConfigValue(cwd, PRIM_COLLECT_SCOPE_VERSION_KEY, String(response.collectScopeVersion));
  return policy === undefined
    ? { kind: "none", version: response.collectScopeVersion }
    : { kind: "policy", policy, version: response.collectScopeVersion };
}

function hasSelectors(values: string[] | undefined): values is string[] {
  return values !== undefined && values.length > 0;
}

function repositoryAdmits(repositories: string[], repository: string | undefined): boolean {
  if (repository === undefined) return false;
  const normalized = repository.toLowerCase();
  return repositories.some((candidate) => candidate.toLowerCase() === normalized);
}

function isCanonicalBranchPattern(value: string): boolean {
  if (value.length === 0 || value.length > MAX_BRANCH_PATTERN_CHARS) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return false;
  }
  return true;
}

/** Match server-owned branch patterns, where wildcards may span slash segments. */
function branchPatternMatches(pattern: string, branch: string): boolean {
  if (!isCanonicalBranchPattern(pattern)) return false;
  let patternIndex = 0;
  let branchIndex = 0;
  let starIndex = -1;
  let retryBranchIndex = 0;

  while (branchIndex < branch.length) {
    const patternCharacter = pattern[patternIndex];
    if (patternCharacter === "?" || patternCharacter === branch[branchIndex]) {
      patternIndex += 1;
      branchIndex += 1;
      continue;
    }
    if (patternCharacter === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      retryBranchIndex = branchIndex;
      continue;
    }
    if (starIndex < 0) return false;
    patternIndex = starIndex + 1;
    retryBranchIndex += 1;
    branchIndex = retryBranchIndex;
  }

  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

function branchAdmits(branches: string[], branch: string | undefined): boolean {
  return branch !== undefined && branches.some((pattern) => branchPatternMatches(pattern, branch));
}

function timeAdmits(policy: CollectScopePolicy, now: number | undefined): boolean {
  if (policy.effectiveFrom === undefined && policy.effectiveUntil === undefined) return true;
  if (now === undefined || !Number.isSafeInteger(now)) return false;
  return (
    (policy.effectiveFrom === undefined || now >= policy.effectiveFrom) &&
    (policy.effectiveUntil === undefined || now < policy.effectiveUntil)
  );
}

function directoryAdmits(directory: string, path: string): boolean {
  return isScopeDirectoryPrefix(directory) && path.startsWith(`${directory}/`);
}

function pathAdmits(policy: CollectScopePolicy, path: string): boolean {
  return (
    (hasSelectors(policy.directories) &&
      policy.directories.some((directory) => directoryAdmits(directory, path))) ||
    (hasSelectors(policy.globs) && policy.globs.some((glob) => matchesScopeGlob(glob, path)))
  );
}

/**
 * Decide whether one local event may be collected under a policy.
 *
 * Policy dimensions compose narrowly: repository, branch, and time selectors
 * must admit their known facts, while any path-bearing event must have every
 * complete target admitted by a directory or glob selector. Path-less events
 * intentionally bypass only the path selectors. Time uses the local hook clock.
 */
export function collectScopeAdmits(
  policy: CollectScopePolicy | null | undefined,
  facts: CollectScopeFacts,
): boolean {
  if (policy === null || policy === undefined) return true;
  if (
    hasSelectors(policy.repositories) &&
    !repositoryAdmits(policy.repositories, facts.repository)
  ) {
    return false;
  }
  if (hasSelectors(policy.branches) && !branchAdmits(policy.branches, facts.branch)) {
    return false;
  }
  if (!timeAdmits(policy, facts.now ?? Date.now())) return false;

  const hasPathSelectors = hasSelectors(policy.directories) || hasSelectors(policy.globs);
  if (!hasPathSelectors || facts.paths === undefined) return true;
  if (facts.pathsComplete !== true || facts.paths.length === 0) return false;
  return facts.paths.every((path) => pathAdmits(policy, path));
}

/** Apply cached-policy posture: no cache is universal; malformed cache is not. */
export function cachedCollectScopeAdmits(cwd: string, facts: CollectScopeFacts): boolean {
  const cached = readCachedCollectScope(cwd);
  if (cached.kind === "invalid") return false;
  return collectScopeAdmits(cached.kind === "policy" ? cached.policy : null, facts);
}

/** Fetch the policy route and commit a validated response into local Git config. */
export async function fetchAndCacheCollectScope(
  cwd: string,
  dependencies: CollectScopeDependencies = defaultDependencies,
): Promise<CachedCollectScope> {
  const response = await dependencies.getClient().get(COLLECT_SCOPE_PATH, {
    signal: dependencies.signal(),
  });
  if (!isDecisionCollectScopeResponse(response)) {
    throw new Error("invalid collection scope response");
  }
  return dependencies.writeCached(cwd, response);
}

export interface CollectScopeRefreshDependencies {
  readCached: (cwd: string) => CachedCollectScope;
  fetch: (cwd: string) => Promise<unknown>;
}

const defaultRefreshDependencies: CollectScopeRefreshDependencies = {
  readCached: readCachedCollectScope,
  fetch: fetchAndCacheCollectScope,
};

const scheduledRefreshes = new Map<string, Promise<void>>();

/**
 * Refresh in the background after an ingest response reports a newer policy.
 * The currently cached policy remains authoritative until this bounded request
 * succeeds; repeated acknowledgements for the same clone share one request.
 */
export function scheduleCollectScopeRefresh(
  cwd: string,
  collectScopeVersion: number,
  dependencies: CollectScopeRefreshDependencies = defaultRefreshDependencies,
): void {
  if (!isSafeVersion(collectScopeVersion)) return;
  const cached = dependencies.readCached(cwd);
  if (
    (cached.kind === "none" || cached.kind === "policy") &&
    cached.version === collectScopeVersion
  ) {
    return;
  }
  if (scheduledRefreshes.has(cwd)) return;

  const refresh = Promise.resolve()
    .then(async () => {
      await dependencies.fetch(cwd);
    })
    .catch(() => undefined)
    .finally(() => {
      scheduledRefreshes.delete(cwd);
    });
  scheduledRefreshes.set(cwd, refresh);
}
