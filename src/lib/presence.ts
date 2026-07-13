import { stripControlChars } from "./ansi.js";

/** An online teammate, optionally annotated with the area of their most
 *  recent decision and its canonical web URL (both server-derived). */
export type Teammate = { name: string; area?: string; decisionUrl?: string };

const DECISION_ORIGIN = "https://app.getprimitive.ai";

/** Return a terminal-safe, production Primitive Decision URL, if valid. */
function validDecisionUrl(value: string | undefined): string | undefined {
  if (typeof value !== "string" || stripControlChars(value) !== value) {
    return undefined;
  }

  try {
    const url = new URL(value);
    if (
      url.origin !== DECISION_ORIGIN ||
      url.username !== "" ||
      url.password !== "" ||
      url.search !== "" ||
      url.hash !== "" ||
      !/^\/decisions\/[^/]+$/u.test(url.pathname)
    ) {
      return undefined;
    }
    return url.href;
  } catch {
    return undefined;
  }
}

function decisionLink(label: string, decisionUrl: string | undefined): string {
  const url = validDecisionUrl(decisionUrl);
  // Style the visible label blue + underlined — a web-style link — so it reads
  // as clickable. Emitted unconditionally, like the OSC 8 escapes: Claude Code
  // renders the statusline, so there is no TTY to gate on. The reset lands
  // before the OSC 8 close, keeping the style off the ", " separator.
  return url ? `\x1b]8;;${url}\x07\x1b[34;4m${label}\x1b[0m\x1b]8;;\x07` : label;
}

/**
 * The shared truncation skeleton behind the presence formatters.
 *
 *   undefined → "—"                 no fresh ack yet (roster unknown)
 *   []        → "just you"          online, but no teammates
 *   ≤ cap     → "Maya, Alex"
 *   > cap     → "Maya, Alex, Sam +2"
 */
function formatLabeled(labels: string[] | undefined, cap: number): string {
  if (labels === undefined) {
    return "—";
  }
  if (labels.length === 0) {
    return "just you";
  }
  if (labels.length <= cap) {
    return labels.join(", ");
  }
  return `${labels.slice(0, cap).join(", ")} +${String(labels.length - cap)}`;
}

/**
 * Render the online-teammate names for the presence surfaces.
 *
 * One shape, two callers: the statusline truncates (a few names + an
 * overflow marker, to stay on one line), while `daemon status` passes
 * Infinity for the full list.
 */
export function formatTeammates(names: string[] | undefined, cap: number): string {
  // Names are server-derived but reach the terminal directly; strip control
  // bytes so a crafted name can't smuggle an escape sequence into the line.
  return formatLabeled(names?.map(stripControlChars), cap);
}

/**
 * Like `formatTeammates`, but annotates each name with the area of the
 * teammate's most recent decision ("Kasey - auth"). Teammates with no known
 * area render bare ("Sam"), so the line stays readable on a mixed team. Same
 * undefined/[]/cap/overflow semantics — length is preserved, so "+N" still
 * counts teammates, not labels.
 */
export function formatTeammatesWithArea(teammates: Teammate[] | undefined, cap: number): string {
  return formatLabeled(
    teammates?.map((t) => {
      // Strip control bytes from the server-derived name/area before they
      // reach the terminal — this is the untrusted-input boundary, so a crafted
      // value can't smuggle an escape into the styled label. Strip before the
      // blank guard: a control-only area (e.g. "\x07") must collapse to empty
      // here, not survive trim() and later strip to a dangling "Name - ".
      const name = stripControlChars(t.name);
      const area = stripControlChars(t.area ?? "").trim();
      const label = area ? `${name} - ${area}` : name;
      return decisionLink(label, t.decisionUrl);
    }),
    cap,
  );
}
