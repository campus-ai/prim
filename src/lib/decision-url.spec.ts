import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decisionLink,
  decisionWebUrl,
  linkedHeadline,
  supportsDecisionHyperlinks,
  validDecisionUrl,
} from "./decision-url.js";

const FULL_ID = "qx7fpmycwabtzke040y7vecnnh8870pg";
const WEB_URL = `https://app.getprimitive.ai/decisions/${FULL_ID}`;
const originalIsTTY = process.stderr.isTTY;

function setStderrTTY(value: boolean | undefined): void {
  Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
}

describe("decisionWebUrl", () => {
  it("builds the web app URL from the full Decision id", () => {
    expect(decisionWebUrl(FULL_ID)).toBe(WEB_URL);
  });

  it("produces a URL its own validator accepts", () => {
    expect(validDecisionUrl(decisionWebUrl(FULL_ID))).toBe(WEB_URL);
  });

  it("percent-encodes a malformed id so it stays one terminal-safe path segment", () => {
    const url = decisionWebUrl("../x?y#z\x1b[2J");
    expect(url).toBe("https://app.getprimitive.ai/decisions/..%2Fx%3Fy%23z%1B%5B2J");
    expect(url).not.toContain("\x1b");
  });
});

describe("decisionLink", () => {
  it("wraps the label in a styled OSC 8 link", () => {
    expect(decisionLink("Use X", WEB_URL, false)).toBe(
      `\x1b]8;;${WEB_URL}\x07\x1b[34;4mUse X\x1b[0m\x1b]8;;\x07`,
    );
  });

  it("returns the bare label when plain or the URL is invalid", () => {
    expect(decisionLink("Use X", WEB_URL, true)).toBe("Use X");
    expect(decisionLink("Use X", "https://evil.example/decisions/x", false)).toBe("Use X");
  });
});

describe("linkedHeadline", () => {
  beforeEach(() => {
    setStderrTTY(true);
    vi.stubEnv("NO_COLOR", "");
    vi.stubEnv("TERM_PROGRAM", "iTerm.app");
  });

  afterEach(() => {
    setStderrTTY(originalIsTTY);
    vi.unstubAllEnvs();
  });

  it("links the quoted headline and hides the URL on an interactive terminal", () => {
    expect(supportsDecisionHyperlinks()).toBe(true);
    expect(linkedHeadline("Use X", FULL_ID)).toBe(decisionLink('"Use X"', WEB_URL, false));
  });

  it("keeps the full URL visible when STDERR is not a TTY (agents, pipes)", () => {
    setStderrTTY(false);
    expect(linkedHeadline("Use X", FULL_ID)).toBe(`"Use X" → ${WEB_URL}`);
  });

  it("keeps the full URL visible under NO_COLOR", () => {
    vi.stubEnv("NO_COLOR", "1");
    expect(linkedHeadline("Use X", FULL_ID)).toBe(`"Use X" → ${WEB_URL}`);
  });

  it("keeps the full URL visible in Terminal.app, which ignores OSC 8", () => {
    vi.stubEnv("TERM_PROGRAM", "Apple_Terminal");
    expect(supportsDecisionHyperlinks()).toBe(false);
    expect(linkedHeadline("Use X", FULL_ID)).toBe(`"Use X" → ${WEB_URL}`);
  });
});
