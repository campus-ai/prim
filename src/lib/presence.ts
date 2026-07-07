/** An online teammate, optionally annotated with the area of their most
 *  recent decision (server-derived and sanitized). */
export type Teammate = { name: string; area?: string };

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
  return formatLabeled(names, cap);
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
      // Guard against a blank/whitespace area (e.g. from an older server that
      // doesn't drop it): render name-only rather than a dangling "Name - ".
      const area = t.area?.trim();
      return area ? `${t.name} - ${area}` : t.name;
    }),
    cap,
  );
}
