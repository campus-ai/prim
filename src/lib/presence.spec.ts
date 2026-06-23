import { describe, expect, it } from "vitest";
import { formatTeammates } from "./presence.js";

describe("formatTeammates", () => {
  it("renders an em dash when names are unknown (no fresh ack)", () => {
    expect(formatTeammates(undefined, 3)).toBe("—");
  });

  it("renders 'just you' when no teammates are online", () => {
    expect(formatTeammates([], 3)).toBe("just you");
  });

  it("joins names at or under the cap", () => {
    expect(formatTeammates(["Maya", "Alex"], 3)).toBe("Maya, Alex");
    expect(formatTeammates(["Maya", "Alex", "Sam"], 3)).toBe("Maya, Alex, Sam");
  });

  it("truncates with an overflow marker over the cap", () => {
    expect(formatTeammates(["Maya", "Alex", "Sam", "Tom"], 3)).toBe("Maya, Alex, Sam +1");
    expect(formatTeammates(["A", "B", "C", "D", "E"], 2)).toBe("A, B +3");
  });

  it("renders the full list when cap is Infinity (daemon status)", () => {
    expect(formatTeammates(["Maya", "Alex", "Sam", "Tom"], Number.POSITIVE_INFINITY)).toBe(
      "Maya, Alex, Sam, Tom",
    );
  });
});
