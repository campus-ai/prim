/**
 * Drift guard: the pre-authorization allow-rule must actually cover the prim
 * invocations our docs tell agents to run.
 *
 * #95 pinned the rule to `@latest`, which matched setup.md's onboarding calls
 * but NOT SKILL.md's day-to-day calls (which omit `@latest`) — so the
 * "your prim calls stop prompting" claim was false for normal operation. This
 * extracts every `npx … @primitive.ai/prim …` invocation from both the
 * onboarding doc (setup.md) and the installed agent contract (SKILL.md) and
 * asserts each one is covered by the rule's authorized prefix. If a doc ever
 * drifts to a flag form the rule doesn't match (e.g. `npx -y`, no `--yes`), this
 * fails — the exact bug class this team tracks.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRIM_PERMISSION_RULE } from "./claude-install.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => readFileSync(resolve(root, name), "utf-8");

// The command prefix the rule authorizes: strip the `Bash(` wrapper and `:*)`
// wildcard. Bash(prefix:*) auto-approves any command starting with `prefix`.
const authorizedPrefix = PRIM_PERMISSION_RULE.replace(/^Bash\(/, "").replace(/:\*\)$/, "");

// Every `npx …@primitive.ai/prim` invocation, captured up to the package name
// (the form the rule must prefix-match), ignoring any trailing `@latest`/args.
function npxPrimInvocations(text: string): string[] {
  return [...text.matchAll(/npx[^\n`]*?@primitive\.ai\/prim/g)].map((m) => m[0]);
}

describe("pre-authorization rule covers the documented prim invocations", () => {
  it("authorizes the bare day-to-day form (the SKILL.md / steady-state case)", () => {
    // Regression pin for #95: this is the form that the @latest rule missed.
    expect("npx --yes @primitive.ai/prim decisions check".startsWith(authorizedPrefix)).toBe(true);
    expect("npx --yes @primitive.ai/prim@latest welcome".startsWith(authorizedPrefix)).toBe(true);
  });

  for (const doc of ["setup.md", "SKILL.md"]) {
    it(`every npx prim invocation in ${doc} is covered by the rule`, () => {
      const invocations = npxPrimInvocations(read(doc));
      expect(invocations.length).toBeGreaterThan(0);
      const uncovered = invocations.filter((cmd) => !cmd.startsWith(authorizedPrefix));
      expect(uncovered).toEqual([]);
    });
  }

  it("setup.md pins @latest on every npx prim call (mirrors the CI local-sentinel)", () => {
    // The onboarding doc must stay @latest-pure so a copy/paste install always
    // runs the newest CLI; the bare day-to-day form belongs in SKILL.md only.
    // Run locally so a stray bare form is caught before CI, not after.
    expect(read("setup.md")).not.toMatch(/npx --yes @primitive\.ai\/prim[^@]/);
  });
});
