import { describe, expect, it } from "vitest";

import { compareSemver } from "./semver.js";

describe("compareSemver", () => {
  it.each([
    ["1.0.0", "1.0.0-alpha", 1],
    ["1.0.0-alpha.10", "1.0.0-alpha.2", 1],
    ["1.0.0-alpha.beta", "1.0.0-alpha.50", 1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0+build.2", "1.0.0+build.1", 0],
    ["1.0.0-alpha.01", "1.0.0-alpha.1", undefined],
    ["1.0", "1.0.0", undefined],
  ])("compares SemVer %s against %s", (left, right, precedence) => {
    expect(compareSemver(left, right)).toBe(precedence);
  });
});
