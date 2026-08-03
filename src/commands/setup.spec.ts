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
 *   - the first seeding proposal is the terminal call-to-action;
 *   - the seed close defers the seeding procedure to the installed prim skill
 *     (proposals mined from memory, one at a time, at most six), closing on
 *     welcome's CLI-owned `seedGuidance`;
 *   - the daemon has an explicit --no-daemon opt-out;
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
const README = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../README.md"),
  "utf-8",
);

const AGENT_PROMPT =
  "Install the Primitive CLI and activate passive decision capture for this repository: run `npx --yes @primitive.ai/prim@latest setup` and surface its output. Drive it yourself; I'll only click Authorize in the browser. This request authorizes setup's built-in activation of this repository and an idempotent retry of that step, but not activation in another repository or creation of a Decision. If enable or health fails, surface the actual error; do not claim fresh activation approval is required. Then show me the welcome.";

const welcomeSection = (): string =>
  SETUP.slice(SETUP.indexOf("## 2."), SETUP.indexOf("## Appendix"));

describe("setup.md onboarding flow", () => {
  it("carries the v1 sentinel", () => {
    expect(SETUP).toContain("<!-- PRIMITIVE_SETUP_V1 -->");
  });

  it("steers onboarding to a user-originated command, not a fetched-doc instruction", () => {
    // The command must come from the user's prompt, not from fetched markdown —
    // otherwise the auto-mode classifier blocks it as untrusted-origin code. The
    // steering note must sit at the very top, before the step-by-step guide.
    const head = SETUP.slice(0, SETUP.indexOf("## 1."));
    expect(head).toContain("npx --yes @primitive.ai/prim@latest setup");
    expect(head.toLowerCase()).toContain("originates from");
    expect(head.toLowerCase()).toContain("classifier");
  });

  it("synchronizes explicit current-repository activation and approval boundaries", () => {
    expect(SETUP).toContain(`> ${AGENT_PROMPT}`);
    expect(README).toContain(AGENT_PROMPT);
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

  it("makes Hermes a first-class agent (the --agent flag, auto-detection, and the hook-consent reminder)", () => {
    // Parity with Claude/Codex: a Hermes user must be able to copy/paste the same
    // setup prompt. We pin the flag, the auto-detect note, and the consent gate
    // whose omission leaves the hooks inert — so a careless edit can't drop them.
    expect(SETUP).toContain("--agent hermes");
    expect(SETUP.toLowerCase()).toContain("auto-detect");
    expect(SETUP).toContain("HERMES_ACCEPT_HOOKS");
  });

  it("pins every prim invocation to @latest (no unversioned npx call)", () => {
    // Mirror of the CI probe: every `npx --yes @primitive.ai/prim` must be
    // immediately followed by `@` (i.e. @latest), never a bare space — otherwise
    // the user could end up on a stale pinned version.
    expect(SETUP).not.toMatch(/npx --yes @primitive\.ai\/prim[^@]/);
  });

  it("documents --no-daemon as the explicit durability opt-out", () => {
    expect(SETUP).toContain("--no-daemon");
  });

  it("never reasserts the false 'next session' permissions premise", () => {
    // Claude Code hot-reloads `permissions`, so the allow-rule takes effect in
    // the current session. The old docs wrongly said it only helped next session.
    expect(SETUP.toLowerCase()).not.toContain("next session");
  });

  it("describes Enforcement as an organization capability without claiming its current state", () => {
    expect(SETUP).toContain(
      "Conflict Gates** can warn, ask, or block when **Enforcement** is enabled",
    );
    expect(SETUP.toLowerCase()).not.toContain("not currently enabled");
  });

  it("delivers the welcome BEFORE the status confirmations (a non-zero confirm can't suppress it)", () => {
    const section = welcomeSection();
    const welcome = section.indexOf("@latest welcome");
    expect(welcome).toBeGreaterThan(-1);
    for (const confirm of ["auth status", "claude status", "daemon status", "skill status"]) {
      expect(section.indexOf(confirm)).toBeGreaterThan(welcome);
    }
  });

  it("handles the viewer-seed branch by deferring the procedure to the installed skill", () => {
    const section = welcomeSection();
    expect(section).toContain('"org": "seed"');
    // The seeding procedure lives in the installed SKILL.md — setup.md points
    // at it instead of carrying its own recording policy (which drifted).
    expect(section).toContain("SKILL.md");
    const flat = section.replace(/\s+/g, " ").toLowerCase();
    expect(flat).toContain("read the prim skill you just installed");
    expect(flat).toContain("never this guide's paraphrase");
    expect(flat).toContain("never draft decisions without it");
  });

  it("makes the first seeding proposal the terminal call-to-action (after the confirmations, stop and wait)", () => {
    const section = welcomeSection();
    // The seed close comes AFTER the last confirmation, so the first proposal
    // is the last thing the agent says — never buried above the checks.
    expect(section.indexOf('"org": "seed"')).toBeGreaterThan(section.indexOf("skill status"));
    // And the contract spells out the terminal-CTA behavior explicitly. Collapse
    // whitespace first so hard-wrapped phrases still match.
    const flat = section.replace(/\s+/g, " ").toLowerCase();
    expect(flat).toContain("stop and wait");
    expect(flat).toContain("nothing after it");
    expect(flat).toContain("make the first proposal the close");
  });

  it("keeps the per-agent memory surfaces in setup.md, out of the skill (onboarding-time detail)", () => {
    const flat = welcomeSection().replace(/\s+/g, " ").toLowerCase();
    expect(flat).toContain("auto-memory");
    expect(flat).toContain("memories injected into this thread");
    expect(flat).toContain("memory snapshot in your system prompt");
  });

  it("seeds via one-at-a-time proposals capped at six, closing on welcome's standing guidance", () => {
    const flat = welcomeSection().replace(/\s+/g, " ").toLowerCase();
    // One proposal per message, at most six, never padded to the quota.
    expect(flat).toContain("one at a time");
    expect(flat).toContain("at most six");
    expect(flat).toContain("never invent a proposal to fill the quota");
    // The close is the CLI-owned guidance: record-anytime, passive capture,
    // and per-repo enable — surfaced verbatim from welcome's JSON.
    expect(flat).toContain("seedguidance");
    expect(flat).toContain("prim enable");
    // The open goals question and its review template are gone for good.
    expect(flat).not.toContain("reverseprompt");
    expect(flat).not.toContain("$found_goals");
    expect(flat).not.toContain("most important goals");
  });
});
