/**
 * ASCII renderer for `prim decisions cascade`.
 *
 * Targets the layout the CEO drafted in image #1: upstream knowledge
 * nodes (referenced files + contexts) on a row at the top, the decision
 * in the middle (with author + date + fan-out), downstream dependents
 * to the right inside a single "N affected" box that lists the first
 * MAX_DEPENDENTS_INLINE intents and collapses the rest with "+ N more".
 *
 * The renderer is intentionally narrow (≤ ~100 cols) and hand-rolled —
 * pulling in a `treeify` / `boxen` dependency for this much output
 * would inflate the cli bundle disproportionately. Pure module:
 * everything below is testable without an HTTP fetcher.
 */

import { color, colorForArea, stripAnsi } from "../lib/ansi.js";
import type { CascadeNode, CascadeResult, CascadeTrigger } from "./cascade.js";

const DEPENDENTS_INLINE_LIMIT = 5;
const KNOWLEDGE_INLINE_LIMIT = 4;
const ISO_DATE_LENGTH = 10;
const INTENT_TRUNC = 60;
const DEFAULT_WIDTH = 80;
const SOFT_WRAP_INDENT = "         "; // 9 spaces — matches "trigger: " prefix

function terminalWidth(): number {
  return process.stdout.columns ?? DEFAULT_WIDTH;
}

/**
 * Word-wrap a single line at the given visible width. Visible width
 * ignores ANSI escapes (measured via `stripAnsi`) so colored output
 * wraps at the same column as plain output. Tokens longer than the
 * width — e.g. very long file paths — fall through unwrapped rather
 * than hard-breaking mid-word (acceptable per the M7 scoping note).
 */
export function softWrap(line: string, opts?: { width?: number; indent?: string }): string[] {
  const width = opts?.width ?? terminalWidth();
  const indent = opts?.indent ?? "";
  if (stripAnsi(line).length <= width) {
    return [line];
  }
  const words = line.split(" ");
  const out: string[] = [];
  let current = "";
  for (const w of words) {
    if (current === "") {
      current = w;
      continue;
    }
    const tentative = `${current} ${w}`;
    if (stripAnsi(tentative).length > width) {
      out.push(current);
      current = `${indent}${w}`;
      continue;
    }
    current = tentative;
  }
  if (current.length > 0) {
    out.push(current);
  }
  return out;
}

function formatDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, ISO_DATE_LENGTH);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) {
    return s;
  }
  return `${s.slice(0, max - 1)}…`;
}

function bracketed(label: string): string {
  return `[${label}]`;
}

function withStarHighlight(label: string, isTrigger: boolean): string {
  if (!isTrigger) {
    return bracketed(label);
  }
  // Color the entire token including brackets so the trigger reads
  // at-a-glance. The ` *` marker stays inside the bracket per image #1.
  return color(bracketed(`${label} *`), "orange");
}

function knowledgeRow(
  files: string[],
  contexts: { id: string; name: string }[],
  triggerFile: string | undefined,
  triggerContextName: string | undefined,
): string[] {
  const tokens: string[] = [];
  for (const ctx of contexts.slice(0, KNOWLEDGE_INLINE_LIMIT)) {
    tokens.push(withStarHighlight(ctx.name, ctx.name === triggerContextName));
  }
  for (const f of files.slice(0, KNOWLEDGE_INLINE_LIMIT - contexts.length)) {
    tokens.push(withStarHighlight(f, f === triggerFile));
  }
  const overflow =
    files.length + contexts.length - tokens.length > 0
      ? ` (+${String(files.length + contexts.length - tokens.length)} more)`
      : "";
  if (tokens.length === 0) {
    return ["  (no upstream knowledge refs)"];
  }
  return [`  ${tokens.join("  ")}${overflow}`];
}

function areaChip(area: string | undefined): string {
  if (!area) {
    return color("[--]", "gray");
  }
  return color(`[${area}]`, colorForArea(area));
}

function countCrossAreaDependents(
  parentArea: string | undefined,
  dependents: CascadeNode[],
): number {
  // When the parent has no area, the cross-area question is
  // undefined — fall back to "count distinct areas among dependents
  // that aren't the dominant one" so the tally still surfaces a
  // useful signal instead of silently rendering zero.
  if (!parentArea) {
    const areaCounts = new Map<string, number>();
    for (const d of dependents) {
      if (d.area) {
        areaCounts.set(d.area, (areaCounts.get(d.area) ?? 0) + 1);
      }
    }
    if (areaCounts.size <= 1) {
      return 0;
    }
    let dominantCount = 0;
    for (const c of areaCounts.values()) {
      if (c > dominantCount) {
        dominantCount = c;
      }
    }
    return dependents.filter((d) => d.area).length - dominantCount;
  }
  let count = 0;
  for (const d of dependents) {
    if (d.area && d.area !== parentArea) {
      count++;
    }
  }
  return count;
}

function dependentsBox(dependents: CascadeNode[]): string[] {
  if (dependents.length === 0) {
    return ["  (no downstream dependents)"];
  }
  const inlineCount = Math.min(dependents.length, DEPENDENTS_INLINE_LIMIT);
  const header = `${String(dependents.length)} affected:`;
  const lines = [`  ${header}`];
  for (const d of dependents.slice(0, inlineCount)) {
    lines.push(`    • ${areaChip(d.area)}  ${truncate(d.intent, INTENT_TRUNC)}`);
  }
  if (dependents.length > inlineCount) {
    lines.push(`    + ${String(dependents.length - inlineCount)} more`);
  }
  return lines;
}

// Build the "what was edited" clause for the rich trigger narrative.
// When `authorName` is known we lead with it ("Maya edited <ref>");
// otherwise we fall back to the impersonal "file '<x>' was edited".
function editedClause(
  type: CascadeTrigger["type"],
  authorName: string | undefined,
  file: string | undefined,
  contextName: string | undefined,
): string | null {
  if (type === "file_edit" && file) {
    return authorName ? `${authorName} edited ${file}` : `file '${file}' was edited`;
  }
  if (type === "context_edit" && contextName) {
    return authorName
      ? `${authorName} edited ${contextName}`
      : `context '${contextName}' was edited`;
  }
  if (type === "supersession") {
    return "an upstream decision was superseded";
  }
  if (type === "confirmation_request") {
    return null; // separate code path
  }
  return null;
}

function triggerLine(result: CascadeResult): string[] {
  const t = result.trigger;
  if (!t) {
    return [];
  }
  if (t.type === "confirmation_request") {
    return [`trigger: asking-policy confirmation request opened at ${formatDate(t.flaggedAt)}.`];
  }
  const clause = editedClause(t.type, t.authorName, t.file, t.contextName);
  if (!clause) {
    return [`trigger: ${t.type} at ${formatDate(t.flaggedAt)}.`];
  }
  // Image-#1 rich form: "<author/file> edited <ref> — <narrative>"
  // narrative is a server-synthesized rationale-shift explanation
  // (e.g. "rationale 'iOS offline reauth' shifted; the implicit
  // assumption behind 7-day refresh changes"). When absent, fall
  // back to the structural "cascade fired at <date>" suffix.
  if (t.narrative) {
    return [`trigger: ${clause} — ${t.narrative}`];
  }
  return [`trigger: ${clause}; cascade fired at ${formatDate(t.flaggedAt)}.`];
}

export function renderCascade(result: CascadeResult): string {
  const d = result.decision;
  const id = d.shortId ? `dec_${d.shortId}` : d.id;
  const idColored = color(id, "orange");
  const header = `what this would break · ${String(result.fanOut)} decision(s) · enforcing`;
  const lines: string[] = [header, "", "knowledge"];
  lines.push(
    ...knowledgeRow(
      result.upstream.files,
      result.upstream.contexts,
      result.trigger?.file,
      result.trigger?.contextName,
    ),
  );
  if (result.trigger && (result.trigger.file || result.trigger.contextName)) {
    lines.push("        |");
    lines.push("        | refs (just edited)");
    lines.push("        ▼");
  }
  const decisionLine = `• ${idColored}  ${truncate(d.intent, INTENT_TRUNC)}`;
  const fanOutFragment =
    result.fanOut > 0 ? `  ·  ${String(result.fanOut)} decision(s) depend on this` : "";
  const meta = `  ${d.authorName} · ${formatDate(d.classifiedAt)}${fanOutFragment}  ·  ${result.reversibility ?? "(unset)"} reversibility`;
  lines.push("", decisionLine, meta);
  lines.push("");
  lines.push("dependents");
  lines.push(...dependentsBox(result.downstream));
  const triggered = triggerLine(result);
  if (triggered.length > 0) {
    lines.push("");
    // Soft-wrap each trigger line with a 9-space continuation indent
    // so a long rationale-shift narrative wraps cleanly under "trigger: ".
    for (const t of triggered) {
      lines.push(...softWrap(t, { indent: SOFT_WRAP_INDENT }));
    }
  }
  const crossArea = countCrossAreaDependents(d.area, result.downstream);
  const crossAreaFragment = crossArea > 0 ? ` · ${String(crossArea)} cross-area dependency` : "";
  const noEdgesFragment = result.downstream.length === 0 ? " (no edges yet)" : "";
  lines.push(
    `impact: ${String(result.fanOut)} decision(s) need review${noEdgesFragment}${crossAreaFragment}.`,
  );
  return lines.join("\n");
}
