/**
 * setup.md onboarding-prompt structure — the copy/paste install snippet a new
 * user pastes into Claude Code / Codex to have the agent drive setup.
 *
 * setup.md isn't executable code, so it has no unit under test — but its FLOW is
 * load-bearing: a careless edit can silently break onboarding for every new user.
 * The current contract LEADS with the single `prim setup` command (one Bash
 * approval for the agent, which then drives the whole install as child processes)
 * and keeps the manual steps as a fallback appendix. We pin the invariants that
 * keep the flow correct and prompt-light:
 *   - the one-shot is the primary, top-of-doc instruction (before the appendix);
 *   - every core command is still wired (incl. the fallback appendix);
 *   - every prim invocation stays pinned to @latest (mirrors the CI probe);
 *   - the welcome is delivered BEFORE the status confirmations (it's the required
 *     final deliverable; a non-zero confirm must not be able to suppress it);
 *   - the seeding question is the terminal call-to-action;
 *   - the daemon stays optional;
 *   - the now-false "next session" permissions premise never returns (Claude Code
 *     hot-reloads permissions, so the allow-rule takes effect this session).
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SETUP = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../setup.md"),
  "utf-8",
);

const welcomeSection = (): string =>
  SETUP.slice(SETUP.indexOf("## 2."), SETUP.indexOf("## Appendix"));

describe("setup.md onboarding flow", () => {
  it("carries the v1 sentinel", () => {
    expect(SETUP).toContain("<!-- PRIMITIVE_SETUP_V1 -->");
  });

  it("leads with the single `prim setup` command, before the fallback appendix", () => {
    const oneShot = SETUP.indexOf("@primitive.ai/prim@latest setup");
    const appendix = SETUP.indexOf("## Appendix");
    expect(oneShot).toBeGreaterThan(-1);
    expect(appendix).toBeGreaterThan(-1);
    // The one-shot is introduced up top, not buried in the fallback steps.
    expect(oneShot).toBeLessThan(appendix);
  });

  it("wires every core onboarding command", () => {
    for (const cmd of [
      "claude preauth",
      "auth login",
      "claude install",
      "codex install",
      "daemon start",
      "hooks install",
      "skill install",
      "welcome",
    ]) {
      expect(SETUP).toContain(cmd);
    }
  });

  it("pins every prim invocation to @latest (no unversioned npx call)", () => {
    // Mirror of the CI probe: every `npx --yes @primitive.ai/prim` must be
    // immediately followed by `@` (i.e. @latest), never a bare space — otherwise
    // the user could end up on a stale pinned version.
    expect(SETUP).not.toMatch(/npx --yes @primitive\.ai\/prim[^@]/);
  });

  it("keeps the daemon optional so a down daemon never blocks setup", () => {
    expect(SETUP.toLowerCase()).toContain("optional");
    expect(SETUP).toContain("--no-daemon");
  });

  it("never reasserts the false 'next session' permissions premise", () => {
    // Claude Code hot-reloads `permissions`, so the allow-rule takes effect in
    // the current session. The old docs wrongly said it only helped next session.
    expect(SETUP.toLowerCase()).not.toContain("next session");
  });

  it("delivers the welcome BEFORE the status confirmations (a non-zero confirm can't suppress it)", () => {
    const section = welcomeSection();
    const welcome = section.indexOf("@latest welcome");
    expect(welcome).toBeGreaterThan(-1);
    for (const confirm of ["auth status", "claude status", "daemon status", "skill status"]) {
      expect(section.indexOf(confirm)).toBeGreaterThan(welcome);
    }
  });

  it("handles the viewer-seed reverse-prompt branch (seed the graph via decisions create)", () => {
    const section = welcomeSection();
    expect(section).toContain('"org": "seed"');
    expect(section).toContain("decisions create");
  });

  it("makes the seeding question the terminal call-to-action (after the confirmations, stop and wait)", () => {
    const section = welcomeSection();
    // The seed CTA + decisions create come AFTER the last confirmation, so the
    // question is the last thing the agent says — never buried above the checks.
    expect(section.indexOf('"org": "seed"')).toBeGreaterThan(section.indexOf("skill status"));
    expect(section.indexOf("decisions create")).toBeGreaterThan(section.indexOf("skill status"));
    // And the contract spells out the terminal-CTA behavior explicitly. Collapse
    // whitespace first so hard-wrapped phrases still match.
    const flat = section.replace(/\s+/g, " ").toLowerCase();
    expect(flat).toContain("stop and wait");
    expect(flat).toContain("nothing after it");
    expect(flat).toContain("hold it back");
  });
});
