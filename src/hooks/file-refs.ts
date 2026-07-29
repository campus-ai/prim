import {
  type CanonicalPathResult,
  type RepositoryContext,
  canonicalRepositoryPath,
} from "../lib/git.js";
import type { Agent } from "./agent.js";
import { extractFileTargets } from "./pre-tool-use-scoring.js";
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
    resolution.rejected.length > 0 ||
    resolution.targetsIncomplete ||
    resolution.targetsTruncated ||
    resolution.shellMutation !== undefined;
  if (!shouldAttach) return;
  return {
    fileRefs: [...resolution.fileRefs],
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
}): HookFileResolution {
  const command =
    args.agent === "claude_code" &&
    args.toolName === "Bash" &&
    args.toolInput &&
    typeof args.toolInput === "object" &&
    typeof (args.toolInput as Record<string, unknown>).command === "string"
      ? ((args.toolInput as Record<string, unknown>).command as string)
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
  for (const path of uniqueRawPaths.slice(0, MAX_PREFLIGHT_FILE_TARGETS)) {
    const canonical = canonicalRepositoryPath(path, args.repository, args.cwd);
    if (canonical.ok) fileRefs.add(canonical.file);
    else rejected.push({ path, reason: canonical.reason });
  }
  return {
    fileRefs: [...fileRefs],
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
