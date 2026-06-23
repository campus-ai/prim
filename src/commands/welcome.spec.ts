/**
 * `prim welcome` — orientation copy coverage. Asserts the formatted block
 * (stripped of ANSI) carries the load-bearing content a first-run user
 * needs: the one-line mental model, the key behaviors, and the starter
 * commands. Color is gated on a stderr TTY, so under vitest the helpers
 * already return plain text — stripAnsi keeps the assertions robust either
 * way.
 */

import { describe, expect, it } from "vitest";
import { stripAnsi } from "../lib/ansi.js";
import { formatWelcome } from "./welcome.js";

const plain = stripAnsi(formatWelcome());

describe("formatWelcome", () => {
  it("leads with the welcome header and the one-line mental model", () => {
    expect(plain).toContain("Welcome to Primitive");
    expect(plain).toContain("captures the decisions your team makes");
  });

  it("covers the key behaviors: automatic capture, the gate + reconcile, confirmations", () => {
    expect(plain).toContain("Capture is automatic");
    expect(plain).toContain("conflict gate");
    expect(plain).toContain("prim reconcile dec_<id>");
    expect(plain).toMatch(/yes\/no prompts/);
  });

  it("lists the starter commands with copy-pasteable, real syntax", () => {
    expect(plain).toContain("prim decisions recent");
    // Use the CLI's own `<files>` placeholder, not a literal ellipsis that
    // would error if pasted.
    expect(plain).toContain("prim decisions check --files <files>");
    expect(plain).toContain("prim --help");
    expect(plain).not.toContain("…");
  });
});
