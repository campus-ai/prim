/**
 * Render the online-teammate list for the presence surfaces.
 *
 * One shape, two callers: the statusline truncates (a few names + an
 * overflow marker, to stay on one line), while `daemon status` passes
 * Infinity for the full list.
 *
 *   undefined → "—"                 no fresh ack yet (count/names unknown)
 *   []        → "just you"          online, but no teammates
 *   ≤ cap     → "Maya, Alex"
 *   > cap     → "Maya, Alex, Sam +2"
 */
export function formatTeammates(names: string[] | undefined, cap: number): string {
  if (names === undefined) {
    return "—";
  }
  if (names.length === 0) {
    return "just you";
  }
  if (names.length <= cap) {
    return names.join(", ");
  }
  return `${names.slice(0, cap).join(", ")} +${String(names.length - cap)}`;
}
