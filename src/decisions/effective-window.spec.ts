import { describe, expect, it } from "vitest";
import {
  EffectiveWindowInputError,
  effectiveWindowFromOptions,
  parseEffectiveInstant,
} from "./effective-window.js";

describe("parseEffectiveInstant", () => {
  it("accepts exact safe Unix milliseconds, including pre-epoch instants", () => {
    expect(parseEffectiveInstant("1789072496789", "--effective-from")).toBe(1_789_072_496_789);
    expect(parseEffectiveInstant("-1", "--effective-until")).toBe(-1);
  });

  it("converts an ISO-8601 date or instant to milliseconds", () => {
    expect(parseEffectiveInstant("2026-09-08", "--effective-from")).toBe(Date.parse("2026-09-08"));
    expect(parseEffectiveInstant("2026-09-08T12:34:56.789+01:00", "--effective-until")).toBe(
      Date.parse("2026-09-08T12:34:56.789+01:00"),
    );
  });

  it.each(["tomorrow", "2026-02-30", "2026-09-08T12:00:00", "9007199254740992"])(
    "rejects non-canonical or unsafe input %s",
    (value) => {
      expect(() => parseEffectiveInstant(value, "--effective-from")).toThrow(
        EffectiveWindowInputError,
      );
    },
  );
});

describe("effectiveWindowFromOptions", () => {
  it("builds a partial or bounded window from CLI options", () => {
    expect(effectiveWindowFromOptions({ effectiveFrom: "1789072496789" })).toEqual({
      effectiveFrom: 1_789_072_496_789,
    });
    expect(
      effectiveWindowFromOptions({
        effectiveFrom: "2026-09-08T00:00:00Z",
        effectiveUntil: "2026-09-09T00:00:00Z",
      }),
    ).toEqual({
      effectiveFrom: Date.parse("2026-09-08T00:00:00Z"),
      effectiveUntil: Date.parse("2026-09-09T00:00:00Z"),
    });
  });

  it("distinguishes an omitted change from an explicit clear", () => {
    expect(effectiveWindowFromOptions({})).toBeUndefined();
    expect(effectiveWindowFromOptions({ clearWindow: true })).toBeNull();
  });

  it("rejects inverted windows and conflicting clear input", () => {
    expect(() => effectiveWindowFromOptions({ effectiveFrom: "2", effectiveUntil: "2" })).toThrow(
      "--effective-from must be before --effective-until",
    );
    expect(() => effectiveWindowFromOptions({ effectiveFrom: "2", clearWindow: true })).toThrow(
      "--clear-window cannot be combined",
    );
  });
});
