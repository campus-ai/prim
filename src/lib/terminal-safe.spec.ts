import { describe, expect, it } from "vitest";
import {
  isTerminalSafeText,
  stripControlChars,
  terminalSafeLine,
  terminalSafeText,
} from "./terminal-safe.js";

describe("terminal-safe", () => {
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);

  it("neutralizes C0/C1 terminal sequences without parsing their payload", () => {
    expect(terminalSafeText(`${ESC}]52;c;payload${BEL}${ESC}[2J`)).toBe("]52;c;payload[2J");
    expect(stripControlChars(`safe${String.fromCharCode(0x9b)}text`)).toBe("safetext");
  });

  it("removes bidi overrides, isolates, zero-width joiners, and invisible tags", () => {
    const invisibleTag = String.fromCodePoint(0xe0061);
    const unsafe = `a\u202eb\u2066c\u200bd\u200de\ufefff${invisibleTag}g`;
    expect(terminalSafeText(unsafe)).toBe("abcdefg");
    expect(isTerminalSafeText(unsafe)).toBe(false);
  });

  it("collapses multiline text while preserving word boundaries", () => {
    expect(terminalSafeLine("  use\n\t the\u0000 safe API  ")).toBe("use the safe API");
  });

  it("replaces isolated surrogates and preserves ordinary Unicode prose", () => {
    expect(terminalSafeLine("Ship 🚀 café \ud800 now")).toBe("Ship 🚀 café � now");
    expect(isTerminalSafeText("Ship 🚀 café")).toBe(true);
  });
});
