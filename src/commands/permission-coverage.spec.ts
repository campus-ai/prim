/**
 * Drift guard: the pre-authorization allow-rule must actually cover the prim
 * invocations our docs tell agents to run — under Claude Code's REAL matcher
 * semantics, not a naive prefix check.
 *
 * History of the bug class this tracks: #95 pinned the rule to `@latest`, which
 * matched setup.md's onboarding calls but not SKILL.md's bare day-to-day calls;
 * #97 then swapped to the bare `…/prim:*` form, which (because Claude Code's
 * trailing `:*` enforces a word boundary — the prefix must be followed by a space
 * or end-of-string) matched the bare form but silently STOPPED matching setup.md's
 * `…/prim@latest …` form. A naive `startsWith` check can't see either gap, because
 * it ignores the boundary. So this extracts every FULL `npx … @primitive.ai/prim …`
 * invocation from both the onboarding doc (setup.md) and the installed agent
 * contract (SKILL.md) and runs it through a faithful model of the matcher. If a
 * doc ever drifts to a flag form the rule doesn't match (e.g. `npx -y`), it fails.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { PRIM_PERMISSION_RULE } from "./claude-install.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const read = (name: string) => readFileSync(resolve(root, name), "utf-8");

/**
 * Faithful model of Claude Code's Bash allow-rule matcher
 * (code.claude.com/docs/en/permissions): a trailing ` *` or `:*` enforces a word
 * boundary (prefix must be followed by a space or end-of-string); a bare trailing
 * `*` has no boundary. This is what makes the guard real — it sees the boundary a
 * `startsWith` check is blind to.
 */
function bashRuleMatches(rule: string, command: string): boolean {
  const inner = /^Bash\((.*)\)$/.exec(rule)?.[1];
  if (inner === undefined) {
    return false;
  }
  if (inner.endsWith(":*") || inner.endsWith(" *")) {
    const prefix = inner.slice(0, -2);
    return (
      command.startsWith(prefix) &&
      (command.length === prefix.length || command[prefix.length] === " ")
    );
  }
  if (inner.endsWith("*")) {
    return command.startsWith(inner.slice(0, -1));
  }
  return command === inner;
}

// Every FULL `npx …@primitive.ai/prim …` invocation, captured to end of line or
// the closing inline-code backtick — including the `@latest`/args the matcher's
// word boundary actually turns on. Captures any npx form (e.g. `npx -y`) so a
// doc drifting to a flag the rule doesn't cover fails here.
function npxPrimInvocations(text: string): string[] {
  return [...text.matchAll(/npx[^\n`]*?@primitive\.ai\/prim[^\n`]*/g)].map((m) => m[0].trim());
}

describe("pre-authorization rule covers the documented prim invocations", () => {
  it("authorizes BOTH the @latest onboarding form and the bare day-to-day form", () => {
    // Regression pins for #95 (bare form missed) and #97 (@latest form missed).
    expect(
      bashRuleMatches(PRIM_PERMISSION_RULE, "npx --yes @primitive.ai/prim decisions check"),
    ).toBe(true);
    expect(
      bashRuleMatches(PRIM_PERMISSION_RULE, "npx --yes @primitive.ai/prim@latest welcome"),
    ).toBe(true);
  });

  for (const doc of ["setup.md", "SKILL.md"]) {
    it(`every npx prim invocation in ${doc} is covered by the rule`, () => {
      const invocations = npxPrimInvocations(read(doc));
      expect(invocations.length).toBeGreaterThan(0);
      const uncovered = invocations.filter((cmd) => !bashRuleMatches(PRIM_PERMISSION_RULE, cmd));
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
