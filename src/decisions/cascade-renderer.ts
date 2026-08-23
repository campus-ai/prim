/**
 * ASCII renderer for `prim decisions cascade`.
 *
 * Renders: upstream knowledge
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
import { terminalSafeLine } from "../lib/terminal-safe.js";
import type { CascadeNode, CascadeResult } from "./cascade.js";

const DEPENDENTS_INLINE_LIMIT = 5;
const KNOWLEDGE_INLINE_LIMIT = 4;
const ISO_DATE_LENGTH = 10;
const INTENT_TRUNC = 60;
const DEFAULT_WIDTH = 80;
const SOFT_WRAP_INDENT = "         "; // 9 spaces — matches the "trigger: " prefix width

function terminalWidth(): number {
  return process.stdout.columns ?? DEFAULT_WIDTH;
}

/**
 * Word-wrap a single line at the given visible width. Visible width
 * ignores ANSI escapes (measured via `stripAnsi`) so colored output
 * wraps at the same column as plain output. Tokens longer than the
 * width — e.g. very long file paths — fall through unwrapped rather
 * than hard-breaking mid-word.
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
  const safe = terminalSafeLine(s);
  if (safe.length <= max) {
    return safe;
  }
  return `${safe.slice(0, max - 1)}…`;
}

function bracketed(label: string): string {
  return `[${terminalSafeLine(label)}]`;
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
  for (const f of files.slice(0, Math.max(0, KNOWLEDGE_INLINE_LIMIT - contexts.length))) {
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
  const safeArea = terminalSafeLine(area ?? "");
  if (!safeArea) {
    return color("[--]", "gray");
  }
  return color(`[${safeArea}]`, colorForArea(safeArea));
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

function triggerHeadline(t: NonNullable<CascadeResult["trigger"]>): string {
  const at = formatDate(t.flaggedAt);
  if (t.type === "file_edit" && t.file) {
    return `trigger: file '${terminalSafeLine(t.file)}' was edited; cascade fired at ${at}.`;
  }
  if (t.type === "context_edit" && t.contextName) {
    return `trigger: context '${terminalSafeLine(t.contextName)}' was edited; cascade fired at ${at}.`;
  }
  if (t.type === "supersession") {
    return `trigger: an upstream decision was superseded; cascade fired at ${at}.`;
  }
  if (t.type === "invalidation") {
    return `trigger: an upstream decision was invalidated; cascade fired at ${at}.`;
  }
  if (t.type === "confirmation_request") {
    return `trigger: asking-policy confirmation request opened at ${at}.`;
  }
  return `trigger: ${terminalSafeLine(t.type)} at ${at}.`;
}

function triggerLine(result: CascadeResult): string[] {
  const t = result.trigger;
  if (!t) {
    return [];
  }
  const lines = [triggerHeadline(t)];
  // The rich detail line: who fired it (server `authorName`) and the
  // free-text triage reason (server `reason`). Either may be absent;
  // render only the parts the server actually projected.
  if (t.authorName) {
    lines.push(`  by ${terminalSafeLine(t.authorName)}`);
  }
  if (t.reason) {
    lines.push(`  reason: ${terminalSafeLine(t.reason)}`);
  }
  return lines;
}

export function renderCascade(result: CascadeResult): string {
  const d = result.decision;
  const shortId = terminalSafeLine(d.shortId ?? "");
  const id = shortId ? `dec_${shortId}` : terminalSafeLine(d.id);
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
  const meta = `  ${terminalSafeLine(d.authorName)} · ${formatDate(d.classifiedAt)}${fanOutFragment}  ·  ${terminalSafeLine(result.reversibility ?? "(unset)")} reversibility`;
  lines.push("", decisionLine, meta);
  lines.push("");
  lines.push("dependents");
  lines.push(...dependentsBox(result.downstream));
  const triggered = triggerLine(result);
  if (triggered.length > 0) {
    lines.push("");
    // Soft-wrap each trigger line with a 9-space continuation indent so a
    // long free-text triage reason wraps cleanly under the "reason: " prefix.
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
  // A clipped blast radius must never read as complete — the server hit a
  // scan cap on at least one projected list, so this subgraph is partial.
  if (result.truncated) {
    lines.push(
      "  ⚠ blast radius truncated — more refs/dependents than the server returns per request; not all shown.",
    );
  }
  return lines.join("\n");
}
