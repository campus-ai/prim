/**
 * Hand-rolled ANSI color helpers for the cli.
 *
 * A minimal in-tree implementation over `picocolors` / `chalk`: the
 * renderer needs ~6 colors + a `dim` modifier + tty detection, all of
 * which fit in ~60 LOC. A dep would add a transitive footprint
 * disproportionate to the small surface area we use.
 *
 * Honors the `NO_COLOR` env convention and `process.stdout.isTTY` —
 * piping output to `cat`, redirecting to a file, or running under CI
 * all degrade gracefully to plain text.
 */

import { terminalSafeLine } from "./terminal-safe.js";

export { stripControlChars } from "./terminal-safe.js";

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
  // 256-color approximation of the orange trigger marker (xterm 208).
  orange: "\u001b[38;5;208m",
  gray: "\u001b[90m",
};

const ANSI_RESET = "\u001b[0m";
const ANSI_DIM = "\u001b[2m";
const ANSI_BOLD = "\u001b[1m";

/**
 * Returns true when ANSI color escapes are safe to emit.
 *
 * prim writes its colored human-readable output exclusively to STDERR
 * (per the AX preference of STDOUT raw machine-readable, STDERR human-
 * readable). Gate color emission on `stderr.isTTY` so piping JSON via
 * `prim ... > out.json` (which makes stdout a file) doesn't strip
 * colors from the stderr stream the user is still watching.
 *
 * Honors `NO_COLOR` (https://no-color.org) and is re-evaluated on
 * every call so tests can monkey-patch `process.stderr.isTTY` for
 * one-off assertions.
 */
export function supportsColor(): boolean {
  if (process.env.NO_COLOR !== undefined && process.env.NO_COLOR !== "") {
    return false;
  }
  return process.stderr.isTTY === true;
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

const MAX_HEALTH_ERROR_LENGTH = 240;

/**
 * Normalize an operator-facing error string for a single-line health/status
 * surface: strip control characters, collapse whitespace, and cap length with
 * an ellipsis. Returns undefined for empty input.
 */
export function boundedHealthError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = terminalSafeLine(value);
  if (!clean) return undefined;
  return clean.length <= MAX_HEALTH_ERROR_LENGTH
    ? clean
    : `${clean.slice(0, MAX_HEALTH_ERROR_LENGTH - 1)}…`;
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
