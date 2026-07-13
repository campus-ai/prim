import { describe, expect, it } from "vitest";
import { formatTeammates, formatTeammatesWithArea } from "./presence.js";

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

describe("formatTeammatesWithArea", () => {
  it("renders an em dash when the roster is unknown (no fresh ack)", () => {
    expect(formatTeammatesWithArea(undefined, 3)).toBe("—");
  });

  it("renders 'just you' when no teammates are online", () => {
    expect(formatTeammatesWithArea([], 3)).toBe("just you");
  });

  it("annotates each name with its area, leaving area-less names bare", () => {
    expect(formatTeammatesWithArea([{ name: "Kasey", area: "auth" }, { name: "Sam" }], 3)).toBe(
      "Kasey - auth, Sam",
    );
  });

  it("links the entire annotated label to a production Decision URL", () => {
    expect(
      formatTeammatesWithArea(
        [
          {
            name: "Kasey",
            area: "auth",
            decisionUrl: "https://app.getprimitive.ai/decisions/rh75k1djya8f43k99318ef08dx8adhth",
          },
          {
            name: "Sam",
            decisionUrl: "https://app.getprimitive.ai/decisions/sam-decision",
          },
        ],
        3,
      ),
    ).toBe(
      "\x1b]8;;https://app.getprimitive.ai/decisions/rh75k1djya8f43k99318ef08dx8adhth\x07Kasey - auth\x1b]8;;\x07, " +
        "\x1b]8;;https://app.getprimitive.ai/decisions/sam-decision\x07Sam\x1b]8;;\x07",
    );
  });

  it("supports a mixed linked and unlinked roster", () => {
    expect(
      formatTeammatesWithArea(
        [
          {
            name: "Kasey",
            area: "auth",
            decisionUrl: "https://app.getprimitive.ai/decisions/kasey-decision",
          },
          { name: "Sam", area: "data" },
        ],
        3,
      ),
    ).toBe(
      "\x1b]8;;https://app.getprimitive.ai/decisions/kasey-decision\x07Kasey - auth\x1b]8;;\x07, Sam - data",
    );
  });

  it("canonicalizes an accepted URL before embedding it", () => {
    expect(
      formatTeammatesWithArea(
        [
          {
            name: "Kasey",
            decisionUrl: "https://APP.GETPRIMITIVE.AI:443/decisions/kasey-decision",
          },
        ],
        3,
      ),
    ).toBe("\x1b]8;;https://app.getprimitive.ai/decisions/kasey-decision\x07Kasey\x1b]8;;\x07");
  });

  it.each([
    ["unparsable", "not a url"],
    ["wrong protocol", "http://app.getprimitive.ai/decisions/abc"],
    ["lookalike host", "https://app.getprimitive.ai.example.com/decisions/abc"],
    ["wrong path", "https://app.getprimitive.ai/users/abc"],
    ["missing id", "https://app.getprimitive.ai/decisions/"],
    ["extra path segment", "https://app.getprimitive.ai/decisions/abc/details"],
    ["query", "https://app.getprimitive.ai/decisions/abc?source=cli"],
    ["hash", "https://app.getprimitive.ai/decisions/abc#details"],
    ["credentials", "https://user@app.getprimitive.ai/decisions/abc"],
    ["control character", "https://app.getprimitive.ai/decisions/abc\u001b]8;;evil\u0007"],
  ])("renders plain text for a %s Decision URL", (_case, decisionUrl) => {
    expect(formatTeammatesWithArea([{ name: "Kasey", area: "auth", decisionUrl }], 3)).toBe(
      "Kasey - auth",
    );
  });

  it("renders name-only when the area is blank or whitespace", () => {
    expect(formatTeammatesWithArea([{ name: "Kasey", area: "  " }, { name: "Sam" }], 3)).toBe(
      "Kasey, Sam",
    );
  });

  it("truncates on the teammate count, not the label width", () => {
    expect(
      formatTeammatesWithArea(
        [
          { name: "Kasey", area: "auth" },
          { name: "Sam", area: "data" },
          { name: "Alex" },
          { name: "Tom", area: "ui" },
        ],
        3,
      ),
    ).toBe("Kasey - auth, Sam - data, Alex +1");
  });

  it("does not count link escapes toward the teammate cap", () => {
    expect(
      formatTeammatesWithArea(
        [
          {
            name: "Kasey",
            area: "auth",
            decisionUrl: "https://app.getprimitive.ai/decisions/kasey-decision",
          },
          { name: "Sam", area: "data" },
          { name: "Alex" },
          { name: "Tom", area: "ui" },
        ],
        3,
      ),
    ).toBe(
      "\x1b]8;;https://app.getprimitive.ai/decisions/kasey-decision\x07Kasey - auth\x1b]8;;\x07, Sam - data, Alex +1",
    );
  });

  it("renders the full annotated list when cap is Infinity (daemon status)", () => {
    expect(
      formatTeammatesWithArea(
        [{ name: "Maya", area: "infra" }, { name: "Alex" }],
        Number.POSITIVE_INFINITY,
      ),
    ).toBe("Maya - infra, Alex");
  });
});
