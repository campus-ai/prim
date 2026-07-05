import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bold,
  color,
  colorForArea,
  dim,
  stripAnsi,
  stripControlChars,
  supportsColor,
} from "./ansi.js";

const originalIsTTY = process.stderr.isTTY;
const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
  // Tests start with a known-TTY state so color helpers emit codes.
  Object.defineProperty(process.stderr, "isTTY", {
    value: true,
    configurable: true,
  });
  // biome-ignore lint/performance/noDelete: env teardown requires actual removal
  delete process.env.NO_COLOR;
});

afterEach(() => {
  Object.defineProperty(process.stderr, "isTTY", {
    value: originalIsTTY,
    configurable: true,
  });
  if (originalNoColor === undefined) {
    // biome-ignore lint/performance/noDelete: env teardown requires actual removal
    delete process.env.NO_COLOR;
  } else {
    process.env.NO_COLOR = originalNoColor;
  }
});

describe("supportsColor", () => {
  it("returns true when stderr is a TTY and NO_COLOR is unset", () => {
    expect(supportsColor()).toBe(true);
  });

  it("returns false when NO_COLOR is set", () => {
    process.env.NO_COLOR = "1";
    expect(supportsColor()).toBe(false);
  });

  it("returns false when NO_COLOR is the empty string only when explicit", () => {
    // Per https://no-color.org any non-empty value disables color.
    process.env.NO_COLOR = "";
    expect(supportsColor()).toBe(true);
  });

  it("returns false when stderr is not a TTY", () => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: false,
      configurable: true,
    });
    expect(supportsColor()).toBe(false);
  });

  it("returns true even when stdout is piped, as long as stderr is a TTY", () => {
    // The bug fix: `prim ... > out.json` keeps colored stderr output flowing.
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    expect(supportsColor()).toBe(true);
  });
});

describe("color / dim / bold", () => {
  it("wraps the text with the matching ANSI escape when supported", () => {
    const out = color("hello", "yellow");
    expect(out).toContain("hello");
    expect(stripAnsi(out)).toBe("hello");
    expect(out).not.toBe("hello"); // codes were applied
  });

  it("returns plain text when color is unsupported", () => {
    process.env.NO_COLOR = "1";
    expect(color("hello", "yellow")).toBe("hello");
    expect(dim("dim")).toBe("dim");
    expect(bold("bold")).toBe("bold");
  });

  it("dim applies the dim escape on the supported path", () => {
    const out = dim("faded");
    expect(out).toContain("faded");
    expect(stripAnsi(out)).toBe("faded");
  });
});

describe("colorForArea", () => {
  it("maps known areas to the canonical ANSI color", () => {
    expect(colorForArea("auth")).toBe("yellow");
    expect(colorForArea("data")).toBe("magenta");
    expect(colorForArea("mobile")).toBe("blue");
    expect(colorForArea("infra")).toBe("cyan");
  });

  it("returns gray for undefined or unrecognized areas", () => {
    expect(colorForArea(undefined)).toBe("gray");
    expect(colorForArea("unknown-future-area")).toBe("gray");
  });
});

describe("stripAnsi", () => {
  it("removes ANSI escape sequences while preserving the literal text", () => {
    const wrapped = color("test", "red");
    expect(stripAnsi(wrapped)).toBe("test");
  });

  it("is a no-op on plain text", () => {
    expect(stripAnsi("nothing to strip")).toBe("nothing to strip");
  });
});

describe("stripControlChars", () => {
  // Build control bytes at runtime so the source stays free of escape literals.
  const ESC = String.fromCharCode(0x1b);
  const BEL = String.fromCharCode(0x07);
  const CR = String.fromCharCode(0x0d);
  const BS = String.fromCharCode(0x08);
  const LF = String.fromCharCode(0x0a);

  it("removes the ESC that introduces CSI and OSC sequences", () => {
    // OSC 52 writes the clipboard; CSI 2J clears the screen. Both start with ESC.
    const osc = `${ESC}]52;c;cGF5bG9hZA==${BEL}`;
    const csi = `${ESC}[2J`;
    expect(stripControlChars(osc)).toBe("]52;c;cGF5bG9hZA==");
    expect(stripControlChars(csi)).toBe("[2J");
    expect(stripControlChars(osc)).not.toContain(ESC);
  });

  it("removes raw C0 controls that overwrite or hide output (CR, BS, BEL, LF)", () => {
    expect(stripControlChars(`safe${CR}spoofed`)).toBe("safespoofed");
    expect(stripControlChars(`a${BS}${BEL}b`)).toBe("ab");
    expect(stripControlChars(`line1${LF}line2`)).toBe("line1line2");
  });

  it("strips DEL and C1 control bytes", () => {
    const del = String.fromCharCode(0x7f);
    const c1csi = String.fromCharCode(0x9b); // CSI as a single C1 introducer
    expect(stripControlChars(`x${del}${c1csi}y`)).toBe("xy");
  });

  it("preserves ordinary printable text (incl. non-ASCII)", () => {
    expect(stripControlChars("access_denied: user cancelled — é")).toBe(
      "access_denied: user cancelled — é",
    );
  });
});
