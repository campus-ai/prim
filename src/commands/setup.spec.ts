/**
 * setup.md onboarding-prompt structure — the copy/paste install snippet a new
 * user pastes into Claude Code / Codex to have the agent drive setup.
 *
 * setup.md isn't executable code, so it has no unit under test — but its FLOW is
 * load-bearing: a careless edit can silently break onboarding for every new user
 * (the exact failure these tests guard against). We assert the invariants that
 * make the flow correct: all six steps present and ordered, every core command
 * wired, the daemon kept optional — and, the regression this pins, the welcome
 * message delivered BEFORE the step-6 status confirmations. Welcome is the
 * required final deliverable; placing it after confirmations that legitimately
 * exit non-zero (a down/booting daemon, an absent skill block) let an optional
 * component abort the run before the user ever saw the welcome.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const SETUP = readFileSync(
  resolve(dirname(fileURLToPath(import.meta.url)), "../../setup.md"),
  "utf-8",
);

describe("setup.md onboarding flow", () => {
  it("has all six steps, in order", () => {
    const positions = [1, 2, 3, 4, 5, 6].map((n) => SETUP.indexOf(`## ${n}.`));
    for (const pos of positions) {
      expect(pos).toBeGreaterThan(-1);
    }
    expect(positions).toEqual([...positions].sort((a, b) => a - b));
  });

  it("wires every core onboarding command", () => {
    for (const cmd of [
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

  it("keeps the daemon (step 3) optional so a down daemon never blocks setup", () => {
    const step3 = SETUP.slice(SETUP.indexOf("## 3."), SETUP.indexOf("## 4."));
    expect(step3.toLowerCase()).toContain("optional");
  });

  it("delivers the welcome BEFORE the step-6 confirmations (a non-zero confirm can't suppress it)", () => {
    const step6 = SETUP.slice(SETUP.indexOf("## 6."));
    const welcome = step6.indexOf("@latest welcome");
    expect(welcome).toBeGreaterThan(-1);
    for (const confirm of ["auth status", "claude status", "daemon status", "skill status"]) {
      expect(step6.indexOf(confirm)).toBeGreaterThan(welcome);
    }
  });
});
