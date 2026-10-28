import { terminalSafeLine } from "../lib/terminal-safe.js";
import { DEFAULT_RULES, scrub } from "./redact.js";

const MAX_EXCERPT_CHARS = 80;
const MAX_TITLE_CHARS = 140;
const MAX_PATH_CHARS = 120;
const MAX_VISIBLE_CONFLICTS = 3;
const SAFE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;

type Conflict = {
  decisionId?: unknown;
  shortId?: unknown;
  title?: unknown;
};

type Coverage = {
  status?: unknown;
  selectionOmissions?: unknown;
  evidenceOmissions?: unknown;
};

export type ApprovalEvidence = {
  conflicts: readonly Conflict[];
  message: string;
  reasonCode: string;
  evaluationCoverage?: Coverage;
};

function displayText(value: string, maxChars: number): string {
  const redacted = scrub(value, DEFAULT_RULES);
  const clean = terminalSafeLine(typeof redacted === "string" ? redacted : "");
  const characters = Array.from(clean);
  return characters.length > maxChars ? `${characters.slice(0, maxChars - 1).join("")}…` : clean;
}

function targetLabel(paths: readonly string[]): string {
  const shown = paths.slice(0, 2).map((path) => `“${displayText(path, MAX_PATH_CHARS)}”`);
  if (shown.length === 0) return "the requested change";
  const remaining = paths.length - shown.length;
  return `${shown.join(" and ")}${remaining > 0 ? ` and ${remaining} more file(s)` : ""}`;
}

export function editPreview(
  toolName: string,
  toolInput: unknown,
  paths: readonly string[],
): string {
  const input =
    toolInput && typeof toolInput === "object" ? (toolInput as Record<string, unknown>) : {};
  const targets = targetLabel(paths);
  if (toolName === "Edit") {
    const before =
      typeof input.old_string === "string" ? displayText(input.old_string, MAX_EXCERPT_CHARS) : "";
    const after =
      typeof input.new_string === "string" ? displayText(input.new_string, MAX_EXCERPT_CHARS) : "";
    return before && after
      ? `Edit ${targets}:\nCurrent text: “${before}”\nProposed replacement: “${after}”`
      : `Edit ${targets}.`;
  }
  if (toolName === "Write" || toolName === "NotebookEdit") return `Write ${targets}.`;
  if (toolName === "Bash" || toolName === "Shell") return `Run a command affecting ${targets}.`;
  return `Change ${targets}.`;
}

function decisionLabel(conflict: Conflict): string {
  const id =
    typeof conflict.shortId === "string" && SAFE_ID.test(conflict.shortId)
      ? `dec_${conflict.shortId}`
      : typeof conflict.decisionId === "string" && SAFE_ID.test(conflict.decisionId)
        ? conflict.decisionId
        : "unknown";
  const title =
    typeof conflict.title === "string" ? displayText(conflict.title, MAX_TITLE_CHARS) : "";
  return title
    ? `Decision ${id}: “${title}”.`
    : `Decision ${id}: details unavailable; inspect it before approving.`;
}

function incomplete(evidence: ApprovalEvidence): boolean {
  const coverage = evidence.evaluationCoverage;
  return (
    (Array.isArray(coverage?.selectionOmissions) && coverage.selectionOmissions.length > 0) ||
    (Array.isArray(coverage?.evidenceOmissions) && coverage.evidenceOmissions.length > 0) ||
    (coverage?.status !== undefined && coverage.status !== "completed") ||
    ["candidate_set_truncated", "evidence_incomplete", "coverage_unverified"].includes(
      evidence.reasonCode,
    )
  );
}

export function approvalSummary(evidence: ApprovalEvidence, preview: string): string {
  const lines = [preview];
  if (evidence.conflicts.length > 0) {
    lines.push("Primitive found a conflict with an existing decision.");
    lines.push(...evidence.conflicts.slice(0, MAX_VISIBLE_CONFLICTS).map(decisionLabel));
    const remaining = evidence.conflicts.length - MAX_VISIBLE_CONFLICTS;
    if (remaining > 0) lines.push(`${remaining} more conflicting decision(s) need inspection.`);
  } else {
    lines.push(
      displayText(evidence.message || "Primitive requires review before this change.", 180),
    );
  }
  if (incomplete(evidence)) {
    lines.push("Some potentially applicable decisions were not fully checked.");
  }
  return lines.filter(Boolean).join("\n");
}
