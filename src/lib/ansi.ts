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

/**
 * Strip C0/C1 control bytes (incl. ESC, BEL, CR, BS, DEL) from untrusted text
 * before it reaches the terminal. Dropping the control bytes that *introduce*
 * escape sequences neutralizes CSI, OSC, and raw C0 vectors without parsing
 * their grammar — nothing can smuggle a sequence past a strip of its introducer.
 * Newlines and tabs go too, which is what a single-line verdict wants (no forged
 * second line).
 *
 * This is the untrusted-input safety boundary; `stripAnsi` is not (it removes
 * only SGR color codes, for width/test purposes). Not a full Unicode sanitizer:
 * bidi/RTL-override and zero-width chars are out of scope.
 */
export function stripControlChars(text: string): string {
  let out = "";
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    // Keep everything except C0 (0x00-0x1f), DEL (0x7f), and C1 (0x80-0x9f).
    if (code > 0x1f && !(code >= 0x7f && code <= 0x9f)) {
      out += ch;
    }
  }
  return out;
}

const MAX_HEALTH_ERROR_LENGTH = 240;

/**
 * Normalize an operator-facing error string for a single-line health/status
 * surface: strip control characters, collapse whitespace, and cap length with
 * an ellipsis. Returns undefined for empty input.
 */
export function boundedHealthError(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const clean = stripControlChars(value).replace(/\s+/g, " ").trim();
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
