import { describe, expect, it } from "vitest";
import { decisionWebUrl, linkedHeadline } from "./decision-url.js";

const FULL_ID = "qx7fpmycwabtzke040y7vecnnh8870pg";
const WEB_URL = `https://app.getprimitive.ai/decisions/${FULL_ID}`;

describe("decisionWebUrl", () => {
  it("builds the web app URL from the full Decision id", () => {
    expect(decisionWebUrl(FULL_ID)).toBe(WEB_URL);
  });

  it("percent-encodes a malformed id so it stays one terminal-safe path segment", () => {
    const url = decisionWebUrl("../x?y#z\x1b[2J");
    expect(url).toBe("https://app.getprimitive.ai/decisions/..%2Fx%3Fy%23z%1B%5B2J");
    expect(url).not.toContain("\x1b");
  });
});

describe("linkedHeadline", () => {
  it("quotes the headline and keeps the full URL visible", () => {
    expect(linkedHeadline("Use X", FULL_ID)).toBe(`"Use X" → ${WEB_URL}`);
  });
});
