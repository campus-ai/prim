import { describe, expect, it } from "vitest";
import { AUTH_FAILURE_PAGE, AUTH_SUCCESS_PAGE, STATE_MISMATCH_PAGE } from "./index.js";

const pages = Object.entries({ AUTH_SUCCESS_PAGE, STATE_MISMATCH_PAGE, AUTH_FAILURE_PAGE });

describe("auth callback pages", () => {
  it.each(pages)("%s leaves no unfilled placeholders", (_name, page) => {
    expect(page).not.toContain("{{");
    expect(page).not.toContain("}}");
  });

  it.each(pages)("%s inlines the favicon and logo assets exactly once", (_name, page) => {
    // Exactly once: a stray placeholder elsewhere (e.g. in an HTML comment)
    // would silently embed a duplicate copy of the asset.
    expect(page.match(/href="data:image\/svg\+xml;base64,/g)).toHaveLength(1);
    expect(page.match(/viewBox="115 160 770 175"/g)).toHaveLength(1);
  });

  it.each(pages)("%s references nothing external beyond XML namespaces", (_name, page) => {
    const urls = page.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    expect(urls.every((url) => url.startsWith("http://www.w3.org/"))).toBe(true);
  });

  it("carries the expected copy", () => {
    expect(AUTH_SUCCESS_PAGE).toContain(">Authenticated<");
    expect(AUTH_SUCCESS_PAGE).toContain("Authentication successful!");
    expect(AUTH_SUCCESS_PAGE).toContain("You can close this tab.");
    expect(STATE_MISMATCH_PAGE).toContain("State mismatch. Authentication failed.");
    expect(AUTH_FAILURE_PAGE).toContain(">Error<");
    expect(AUTH_FAILURE_PAGE).toContain("Authentication failed.");
    expect(AUTH_FAILURE_PAGE).toContain("Return to your terminal for details.");
  });
});
