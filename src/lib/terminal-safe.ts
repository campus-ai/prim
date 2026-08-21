/**
 * Terminal-safety boundary for untrusted display text.
 *
 * Human renderers must pass server- or user-controlled strings through this
 * module before adding CLI-owned ANSI styling. Machine-readable JSON must use
 * the original values so this presentation boundary never changes the wire
 * contract.
 */

/** Replace unpaired UTF-16 surrogates with the Unicode replacement character. */
function replaceIsolatedSurrogates(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += "\ufffd";
    } else {
      out += value[index];
    }
  }
  return out;
}

function isUnsafeTerminalCodePoint(point: number): boolean {
  const c0OrC1 = point <= 0x1f || (point >= 0x7f && point <= 0x9f);
  const bidiOrZeroWidth =
    point === 0x00ad || // soft hyphen
    point === 0x061c || // Arabic letter mark
    point === 0x180e || // Mongolian vowel separator
    (point >= 0x200b && point <= 0x200f) || // zero-width + directional marks
    (point >= 0x202a && point <= 0x202e) || // bidi embeddings/overrides
    (point >= 0x2060 && point <= 0x206f) || // word joiner + bidi isolates/controls
    (point >= 0xfff9 && point <= 0xfffb) || // interlinear annotation controls
    point === 0xfeff || // zero-width no-break space / BOM
    (point >= 0xe0000 && point <= 0xe007f); // invisible Unicode tag characters
  return c0OrC1 || bidiOrZeroWidth;
}

/**
 * Remove terminal control bytes, bidi controls, and zero-width formatting
 * characters while preserving ordinary Unicode prose. Newlines and tabs are
 * removed; use {@link terminalSafeLine} when word separation must be kept.
 */
export function terminalSafeText(value: string): string {
  return Array.from(replaceIsolatedSurrogates(value))
    .filter((character) => !isUnsafeTerminalCodePoint(character.codePointAt(0) ?? 0))
    .join("");
}

/**
 * Normalize untrusted text for a single human-readable terminal line.
 * Whitespace is collapsed before controls are removed so embedded newlines do
 * not concatenate otherwise separate words.
 */
export function terminalSafeLine(value: string): string {
  return terminalSafeText(value.replace(/\s+/gu, " ")).replace(/\s+/gu, " ").trim();
}

/** True only when a string needs no terminal-safety normalization. */
export function isTerminalSafeText(value: string): boolean {
  return terminalSafeText(value) === value;
}

/** Backward-compatible name for callers that need control removal without wrapping. */
export const stripControlChars = terminalSafeText;
