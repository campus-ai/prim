import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DecisionFileScopeError, resolveDecisionFileScope } from "./file-scope.js";

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "prim-decision-scope-"));
  const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "test@example.com");
  git("config", "user.name", "Test");
  writeFileSync(join(root, "README.md"), "x\n");
  git("add", "README.md");
  git("commit", "-qm", "init");
  return root;
}

describe("resolveDecisionFileScope", () => {
  it("deduplicates canonical git-root-relative files and supplies repoKey", () => {
    const root = repo();
    const result = resolveDecisionFileScope(["src/a.ts", "src/../src/a.ts"], root);
    expect(result.files).toEqual(["src/a.ts"]);
    expect(result.repoKey).toMatch(/^repo_v1_/);
  });

  it("rejects paths outside the current repository", () => {
    const root = repo();
    expect(() => resolveDecisionFileScope(["../outside.ts"], root)).toThrow(DecisionFileScopeError);
  });
});
