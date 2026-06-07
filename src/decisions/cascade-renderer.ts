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

import type { CascadeNode, CascadeResult } from "./cascade.js";

const DEPENDENTS_INLINE_LIMIT = 5;
const KNOWLEDGE_INLINE_LIMIT = 4;
const ISO_DATE_LENGTH = 10;
const INTENT_TRUNC = 60;

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

function knowledgeRow(
  files: string[],
  contexts: { id: string; name: string }[],
  triggerFile: string | undefined,
  triggerContextName: string | undefined,
): string[] {
  const tokens: string[] = [];
  for (const ctx of contexts.slice(0, KNOWLEDGE_INLINE_LIMIT)) {
    const star = ctx.name === triggerContextName ? " *" : "";
    tokens.push(bracketed(`${ctx.name}${star}`));
  }
  for (const f of files.slice(0, KNOWLEDGE_INLINE_LIMIT - contexts.length)) {
    const star = f === triggerFile ? " *" : "";
    tokens.push(bracketed(`${f}${star}`));
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
  return area ? `[${area}]` : "[--]";
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

function triggerLine(result: CascadeResult): string[] {
  const t = result.trigger;
  if (!t) {
    return [];
  }
  if (t.type === "file_edit" && t.file) {
    return [`trigger: file '${t.file}' was edited; cascade fired at ${formatDate(t.flaggedAt)}.`];
  }
  if (t.type === "context_edit" && t.contextName) {
    return [
      `trigger: context '${t.contextName}' was edited; cascade fired at ${formatDate(t.flaggedAt)}.`,
    ];
  }
  if (t.type === "supersession") {
    return [
      `trigger: an upstream decision was superseded; cascade fired at ${formatDate(t.flaggedAt)}.`,
    ];
  }
  if (t.type === "confirmation_request") {
    return [`trigger: asking-policy confirmation request opened at ${formatDate(t.flaggedAt)}.`];
  }
  return [`trigger: ${t.type} at ${formatDate(t.flaggedAt)}.`];
}

export function renderCascade(result: CascadeResult): string {
  const d = result.decision;
  const id = d.shortId ? `dec_${d.shortId}` : d.id;
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
  const decisionLine = `• ${id}  ${truncate(d.intent, INTENT_TRUNC)}`;
  const fanOutFragment =
    result.fanOut > 0 ? `  ·  ${String(result.fanOut)} decision(s) depend on this` : "";
  const meta = `  ${d.authorName} · ${formatDate(d.classifiedAt)}${fanOutFragment}  ·  ${result.reversibility ?? "(unset)"} reversibility`;
  lines.push("", decisionLine, meta);
  lines.push("");
  lines.push("dependents");
  lines.push(...dependentsBox(result.downstream));
  const triggered = triggerLine(result);
  if (triggered.length > 0) {
    lines.push("", ...triggered);
  }
  const crossArea = countCrossAreaDependents(d.area, result.downstream);
  const crossAreaFragment = crossArea > 0 ? ` · ${String(crossArea)} cross-area dependency` : "";
  const noEdgesFragment = result.downstream.length === 0 ? " (no edges yet)" : "";
  lines.push(
    `impact: ${String(result.fanOut)} decision(s) need review${noEdgesFragment}${crossAreaFragment}.`,
  );
  return lines.join("\n");
}
