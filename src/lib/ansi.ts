/**
 * Hand-rolled ANSI color helpers for the cli.
 *
 * Surgical-minimalist choice over `picocolors` / `chalk`: the renderer
 * needs ~6 colors + a `dim` modifier, all of which fit in ~60 LOC. A
 * dep would add a transitive footprint disproportionate to the small
 * surface area we use.
 *
 * Color is emitted unconditionally for the human-readable STDERR output
 * — regardless of TTY, pipe, or file — so it survives being run under an
 * agent or captured for a recording. `NO_COLOR` (https://no-color.org)
 * is the universal opt-out. STDOUT stays raw JSON; color is never
 * applied there.
 */

export type AnsiColor =
  | "yellow"
  | "magenta"
  | "blue"
  | "cyan"
  | "green"
  | "red"
  | "orange"
  | "gray";

const ANSI_CODES: Record<AnsiColor, string> = {
  yellow: "\u001b[33m",
  magenta: "\u001b[35m",
  blue: "\u001b[34m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  // 256-color approximation of image #1's orange marker (xterm 208).
  orange: "\u001b[38;5;208m",
  gray: "\u001b[90m",
};

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[2m";
const ANSI_BOLD = "\u001b[1m";

/**
 * Returns true when ANSI color escapes should be emitted.
 *
 * prim writes its colored human-readable output exclusively to STDERR
 * (per the AX preference of STDOUT raw machine-readable, STDERR human-
 * readable). Color is always enabled regardless of whether STDERR is a
 * TTY, a pipe, or a file — the human output stays colored when run under
 * an agent (piped), redirected, or captured for a recording. The
 * machine-readable STDOUT is unaffected: color() is only ever applied on
 * the STDERR render paths, never to the JSON stream.
 *
 * Honors `NO_COLOR` (https://no-color.org) as the universal opt-out and
 * is re-evaluated on every call so tests can monkey-patch the env.
 */
export function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  return true;
}

export function color(text: string, c: AnsiColor): string {
  if (!supportsColor()) {
    return text;
  }
  return `${ANSI_CODES[c]}${text}${ANSI_RESET}`;
}

export function dim(text: string): string {
  if (!supportsColor()) {
    return text;
  }
  return `${ANSI_DIM}${text}${ANSI_RESET}`;
}

export function bold(text: string): string {
  if (!supportsColor()) {
    return text;
  }
  return `${ANSI_BOLD}${text}${ANSI_RESET}`;
}

/**
 * Area → color mapping. Mirrors the spec's functional areas. Anything
 * outside this set falls through to `gray` so the chip still renders
 * but visually de-emphasizes vs the canonical ones.
 */
const AREA_COLORS: Record<string, AnsiColor> = {
  auth: "yellow",
  data: "magenta",
  mobile: "blue",
  infra: "cyan",
  ui: "green",
  billing: "orange",
  api: "blue",
  docs: "gray",
  testing: "gray",
};

export function colorForArea(area: string | undefined): AnsiColor {
  if (!area) {
    return "gray";
  }
  return AREA_COLORS[area] ?? "gray";
}

/**
 * Strip ANSI escape sequences from a string. Used by tests to assert
 * structural output independent of color, and by `softWrap` to measure
 * the rendered width correctly.
 */
export function stripAnsi(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes contain control characters by design.
  return text.replace(/\u001b\[[0-9;]*m/g, "");
}
