import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { bold, color, colorForArea, dim, stripAnsi, supportsColor } from "./ansi.js";

const originalIsTTY = process.stdout.isTTY;
const originalNoColor = process.env.NO_COLOR;

beforeEach(() => {
  // Tests start with a known-TTY state so color helpers emit codes.
  Object.defineProperty(process.stdout, "isTTY", {
    value: true,
    configurable: true,
  });
  // biome-ignore lint/performance/noDelete: env teardown requires actual removal
  delete process.env.NO_COLOR;
});

afterEach(() => {
  Object.defineProperty(process.stdout, "isTTY", {
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
  it("returns true when stdout is a TTY and NO_COLOR is unset", () => {
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

  it("returns false when stdout is not a TTY", () => {
    Object.defineProperty(process.stdout, "isTTY", {
      value: false,
      configurable: true,
    });
    expect(supportsColor()).toBe(false);
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
