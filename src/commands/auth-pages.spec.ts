import { describe, expect, it } from "vitest";
import { FAILURE_HTML, STATE_MISMATCH_HTML, SUCCESS_HTML } from "./auth-pages.js";

const pages = Object.entries({ SUCCESS_HTML, STATE_MISMATCH_HTML, FAILURE_HTML });

// The bytes auth.ts's callback tests forbid in any served page: a "script"
// substring or a terminal escape/bell would break resolveCallbackPage's
// "untrusted text never reaches the HTML" guarantee. Locked here so a future
// template edit can't silently regress those assertions.
const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

describe("auth callback pages", () => {
  it.each(pages)("%s is a complete, self-contained document", (_name, page) => {
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain('<meta charset="utf-8" />');
  });

  it.each(pages)("%s inlines the favicon and wordmark exactly once", (_name, page) => {
    // A stray duplicate would silently embed a second copy of the asset.
    expect(page.match(/href="data:image\/svg\+xml;base64,/g)).toHaveLength(1);
    expect(page.match(/viewBox="115 160 770 175"/g)).toHaveLength(1);
  });

  it.each(pages)("%s makes no external request beyond the XML namespace", (_name, page) => {
    const urls = page.match(/https?:\/\/[^"'\s)]+/g) ?? [];
    expect(urls.every((url) => url.startsWith("http://www.w3.org/"))).toBe(true);
  });

  it.each(pages)("%s reflects no script or terminal-escape bytes", (_name, page) => {
    expect(page).not.toContain("script");
    expect(page).not.toContain(ESC);
    expect(page).not.toContain(BEL);
  });

  it("the success page carries only the success copy", () => {
    expect(SUCCESS_HTML).toContain("<title>Primitive — Authenticated</title>");
    expect(SUCCESS_HTML).toContain(">Authenticated<");
    expect(SUCCESS_HTML).toContain(">Authentication successful!<");
    expect(SUCCESS_HTML).toContain(">You can close this tab.<");
    expect(SUCCESS_HTML).not.toContain("failed");
    expect(SUCCESS_HTML).not.toContain("Return to your terminal");
  });

  it("the generic failure page carries only the generic failure copy", () => {
    expect(FAILURE_HTML).toContain("<title>Primitive — Authentication failed</title>");
    expect(FAILURE_HTML).toContain(">Error<");
    expect(FAILURE_HTML).toContain(">Authentication failed.<");
    expect(FAILURE_HTML).toContain(">Return to your terminal for details.<");
    expect(FAILURE_HTML).not.toContain("State mismatch");
    expect(FAILURE_HTML).not.toContain("successful");
  });

  it("the state-mismatch page carries the state-mismatch headline", () => {
    expect(STATE_MISMATCH_HTML).toContain("<title>Primitive — Authentication failed</title>");
    expect(STATE_MISMATCH_HTML).toContain(">Error<");
    expect(STATE_MISMATCH_HTML).toContain(">State mismatch. Authentication failed.<");
    expect(STATE_MISMATCH_HTML).toContain(">Return to your terminal for details.<");
    expect(STATE_MISMATCH_HTML).not.toContain("successful");
  });
});
