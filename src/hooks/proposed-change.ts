import type { Agent } from "./agent.js";
import { scrubFromCwd } from "./redact.js";

export const PROPOSED_CHANGE_MAX_BYTES = 6 * 1024;

export type ProposedChangePreview = {
  tool: string;
  preview: string;
  truncated: boolean;
};

export type ConflictCheckV2Request = {
  protocolVersion: 2;
  file: string;
  repoKey?: string;
  proposedChange: ProposedChangePreview;
};

export type PreflightObservationV2Request = {
  protocolVersion: 2;
  outcome: "unverified";
  reasonCode: "shell_mutation_unverified";
  tool: "Bash";
  repoKey?: string;
};

export function conflictCheckV2Request(
  file: string,
  repoKey: string | undefined,
  proposedChange: ProposedChangePreview,
): ConflictCheckV2Request {
  return {
    protocolVersion: 2,
    file,
    ...(repoKey ? { repoKey } : {}),
    proposedChange,
  };
}

/** Metadata-only observation for a likely Bash mutation with no safe target. */
export function shellMutationUnverifiedObservation(
  repoKey: string | undefined,
): PreflightObservationV2Request {
  return {
    protocolVersion: 2,
    outcome: "unverified",
    reasonCode: "shell_mutation_unverified",
    tool: "Bash",
    ...(repoKey ? { repoKey } : {}),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function editPreview(input: Record<string, unknown>): Record<string, unknown> {
  // Adopted content comes first so a large replaced block cannot push the
  // proposed mechanism beyond the bounded semantic preview.
  return {
    new_string: input.new_string,
    old_string: input.old_string,
    replace_all: input.replace_all,
  };
}

function multiEditPreview(value: unknown): unknown[] {
  if (!Array.isArray(value)) return [];
  return value.map((edit) => {
    const input = asRecord(edit);
    return input ? editPreview(input) : edit;
  });
}

function previewSource(toolName: string, toolInput: unknown, agent: Agent): unknown {
  const input = asRecord(toolInput);
  if (!input) return "";
  if (toolName === "Bash") return typeof input.command === "string" ? input.command : "";
  if (agent === "codex" && toolName === "apply_patch") {
    return typeof input.command === "string" ? input.command : "";
  }
  if (agent === "hermes") {
    if (toolName === "write_file") return input.content ?? "";
    if (toolName === "patch") {
      return input.mode === "patch" ? (input.patch ?? "") : editPreview(input);
    }
  }
  if (toolName === "Write") return input.content ?? "";
  if (toolName === "Edit") return editPreview(input);
  if (toolName === "MultiEdit") return multiEditPreview(input.edits);
  if (toolName === "NotebookEdit") {
    return {
      cell_id: input.cell_id,
      cell_type: input.cell_type,
      edit_mode: input.edit_mode,
      new_source: input.new_source,
    };
  }
  return "";
}

function toText(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return "";
  }
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.byteLength <= maxBytes) return { value, truncated: false };
  let end = maxBytes;
  // UTF-8 continuation bytes cannot start a valid suffix. Back up to the lead
  // byte so truncation never inserts U+FFFD into the model preview.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return { value: bytes.subarray(0, end).toString("utf8"), truncated: true };
}

function containsOversizedRedaction(value: unknown): boolean {
  if (typeof value === "string") return value.includes("<REDACTED:oversized>");
  if (Array.isArray(value)) return value.some(containsOversizedRedaction);
  return asRecord(value)
    ? Object.values(value as Record<string, unknown>).some(containsOversizedRedaction)
    : false;
}

/** Build a secret-scrubbed, bounded preview for the v2 semantic check. */
export function proposedChangePreview(
  toolName: string,
  toolInput: unknown,
  cwd: string,
  agent: Agent,
  repoRoot: string = cwd,
): ProposedChangePreview {
  const source = previewSource(toolName, toolInput, agent);
  const scrubbed = scrubFromCwd(source, cwd, repoRoot);
  const bounded = truncateUtf8(toText(scrubbed), PROPOSED_CHANGE_MAX_BYTES);
  return {
    tool: toolName,
    preview: bounded.value,
    truncated: bounded.truncated || containsOversizedRedaction(scrubbed),
  };
}
