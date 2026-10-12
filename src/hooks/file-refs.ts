import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { cachedCollectScopeAdmits } from "../lib/collect-scope.js";
import {
  type CanonicalPathResult,
  type RepositoryContext,
  canonicalRepositoryPath,
  currentBranch,
  relatedWorktreeTarget,
} from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Agent } from "./agent.js";
import { extractFileTargets } from "./pre-tool-use-scoring.js";
import { scrubEnvironmentPaths } from "./redact.js";
import { analyzeShellTargets } from "./shell-targets.js";

export const MAX_PREFLIGHT_FILE_TARGETS = 25;

export function rejectedTargetWarning(
  reason: Extract<CanonicalPathResult, { ok: false }>["reason"],
): string {
  return reason === "outside_repository"
    ? "target outside repository was not checked"
    : "target path could not be verified";
}

export type HookFileResolution = {
  targetCheckouts?: Array<{
    gitRoot: string;
    workspaceId: string;
    repoSyncId: string;
    fileRefs: string[];
  }>;
  fileRefs: string[];
  rejected: Array<{ path: string; reason: Extract<CanonicalPathResult, { ok: false }>["reason"] }>;
  shellMutation?: "none" | "resolved" | "unresolved";
  targetsIncomplete: boolean;
  targetsTruncated: boolean;
};

function primitiveMetadataForResolution(
  resolution: HookFileResolution,
): Record<string, unknown> | undefined {
  const shouldAttach =
    resolution.fileRefs.length > 0 ||
    (resolution.targetCheckouts?.length ?? 0) > 0 ||
    resolution.rejected.length > 0 ||
    resolution.targetsIncomplete ||
    resolution.targetsTruncated ||
    resolution.shellMutation !== undefined;
  if (!shouldAttach) return;
  return {
    fileRefs: [...resolution.fileRefs],
    ...(resolution.targetCheckouts ? { targetCheckouts: resolution.targetCheckouts } : {}),
    ...(resolution.rejected.length > 0 || resolution.targetsIncomplete
      ? { fileRefsIncomplete: true }
      : {}),
    ...(resolution.targetsTruncated ? { fileRefsTruncated: true } : {}),
    ...(resolution.shellMutation !== undefined ? { shellMutation: resolution.shellMutation } : {}),
  };
}

/** Restore CLI-owned canonical control metadata after content redaction. */
export function preserveHookFileMetadata(
  payload: unknown,
  resolution: HookFileResolution,
): unknown {
  const primitive = primitiveMetadataForResolution(resolution);
  if (!primitive || !payload || typeof payload !== "object" || Array.isArray(payload)) {
    return payload;
  }
  return { ...(payload as Record<string, unknown>), primitive };
}

/** Resolve the paths exposed by a hook tool against one canonical git root. */
export function resolveHookFileRefs(args: {
  toolName: string;
  toolInput: unknown;
  agent: Agent;
  cwd: string;
  repository: RepositoryContext;
  captureTargets?: boolean;
}): HookFileResolution {
  const isShellTool =
    ((args.agent === "claude_code" || args.agent === "codex") && args.toolName === "Bash") ||
    (args.agent === "cursor" && args.toolName === "Shell");
  const command = isShellTool
    ? typeof args.toolInput === "string"
      ? args.toolInput
      : args.toolInput &&
          typeof args.toolInput === "object" &&
          typeof (args.toolInput as Record<string, unknown>).command === "string"
        ? ((args.toolInput as Record<string, unknown>).command as string)
        : undefined
    : undefined;
  const shell = command === undefined ? undefined : analyzeShellTargets(command);
  const shellMutation =
    shell?.mutation === "none"
      ? ("none" as const)
      : shell?.coverage === "complete"
        ? ("resolved" as const)
        : shell
          ? ("unresolved" as const)
          : undefined;
  // Unverified shell syntax may change cwd or otherwise alter the basis of
  // otherwise-literal paths. Preserve the explicit incomplete marker without
  // attaching ambiguous repository refs.
  const readPath =
    args.agent === "claude_code" &&
    args.toolName === "Read" &&
    args.toolInput &&
    typeof args.toolInput === "object" &&
    typeof (args.toolInput as Record<string, unknown>).file_path === "string"
      ? [(args.toolInput as Record<string, string>).file_path]
      : undefined;
  const nativeTargets = shell
    ? null
    : readPath
      ? { paths: readPath, complete: true }
      : extractFileTargets(args.toolName, args.toolInput, args.agent);
  const rawPaths = shell
    ? shellMutation === "unresolved"
      ? []
      : shell.paths
    : (nativeTargets?.paths ?? []);
  const uniqueRawPaths = Array.from(new Set(rawPaths));
  const targetsTruncated = uniqueRawPaths.length > MAX_PREFLIGHT_FILE_TARGETS;
  const fileRefs = new Set<string>();
  const rejected: HookFileResolution["rejected"] = [];
  const targets = new Map<string, { repository: RepositoryContext; fileRefs: string[] }>();
  for (const path of uniqueRawPaths.slice(0, MAX_PREFLIGHT_FILE_TARGETS)) {
    const canonical = canonicalRepositoryPath(path, args.repository, args.cwd);
    if (canonical.ok) fileRefs.add(canonical.file);
    else {
      const target =
        args.captureTargets && canonical.reason === "outside_repository"
          ? relatedWorktreeTarget(path, args.cwd, args.repository)
          : null;
      const resolved = target ? canonicalRepositoryPath(path, target, args.cwd) : null;
      if (
        target &&
        resolved?.ok &&
        isRepoActiveForCapture(target.repoRoot) &&
        repoSyncId(target.repoRoot) === args.repository.repoSyncId &&
        args.repository.repoSyncId &&
        cachedCollectScopeAdmits(target.repoRoot, {
          repository: target.repoFullName,
          branch: currentBranch(target.repoRoot),
          agent: args.agent,
          paths: [resolved.file],
          pathsComplete: true,
        })
      ) {
        const group = targets.get(target.repoRoot) ?? { repository: target, fileRefs: [] };
        group.fileRefs.push(resolved.file);
        targets.set(target.repoRoot, group);
      } else rejected.push({ path, reason: canonical.reason });
    }
  }
  const targetCheckouts: NonNullable<HookFileResolution["targetCheckouts"]> = [];
  if (targets.size > 0) {
    if (fileRefs.size > 0)
      targets.set(args.repository.repoRoot, {
        repository: args.repository,
        fileRefs: [...fileRefs],
      });
    for (const { repository, fileRefs: paths } of targets.values()) {
      const identity = getOrCreateWorkspaceId(repository.repoRoot);
      const binding = repoSyncId(repository.repoRoot);
      if (identity.status !== "ready" || !binding) {
        rejected.push({ path: repository.repoRoot, reason: "invalid_path" });
        continue;
      }
      const root = scrubEnvironmentPaths({
        cwd: repository.repoRoot,
        gitRoot: repository.repoRoot,
      }).gitRoot;
      targetCheckouts.push({
        gitRoot: root,
        workspaceId: identity.workspaceId,
        repoSyncId: binding,
        fileRefs: paths,
      });
    }
  }
  return {
    fileRefs: [...fileRefs],
    ...(targetCheckouts.length > 0 ? { targetCheckouts } : {}),
    rejected,
    targetsIncomplete: nativeTargets?.complete === false,
    targetsTruncated,
    ...(shellMutation
      ? { shellMutation: targetsTruncated ? ("unresolved" as const) : shellMutation }
      : {}),
  };
}

export function enrichHookPayloadWithFileRefs(args: {
  parsed: Record<string, unknown>;
  agent: Agent;
  cwd: string;
  repository: RepositoryContext;
}): { parsed: Record<string, unknown>; resolution: HookFileResolution } {
  const toolName = typeof args.parsed.tool_name === "string" ? args.parsed.tool_name : "";
  const resolution = resolveHookFileRefs({
    toolName,
    toolInput: args.parsed.tool_input,
    agent: args.agent,
    cwd: args.cwd,
    repository: args.repository,
    captureTargets: true,
  });
  const primitive = primitiveMetadataForResolution(resolution);
  if (!primitive) return { parsed: args.parsed, resolution };
  return {
    parsed: {
      ...args.parsed,
      // An explicit empty list is authoritative when every exposed target was
      // rejected. It prevents backend fallback to unsafe raw tool input.
      primitive,
    },
    resolution,
  };
}
