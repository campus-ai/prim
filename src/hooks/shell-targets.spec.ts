import { describe, expect, it } from "vitest";
import { analyzeShellTargets } from "./shell-targets.js";

describe("analyzeShellTargets", () => {
  it("extracts literal redirects, tee, touch, rm, and single-source copy/move effects", () => {
    expect(
      analyzeShellTargets(
        "printf x > src/a.ts && echo y | tee -a 'src/b file.ts'; touch c; rm -- d; cp e f; mv g h",
      ),
    ).toEqual({
      paths: ["src/a.ts", "src/b file.ts", "c", "d", "f", "g", "h"],
      coverage: "complete",
      mutation: "present",
    });
  });

  it("recognizes a supported read-only call and ignores descriptor sinks", () => {
    expect(analyzeShellTargets("printf ok 2>/dev/null")).toEqual({
      paths: [],
      coverage: "complete",
      mutation: "none",
    });
    expect(analyzeShellTargets("echo ok 2>&1")).toEqual({
      paths: [],
      coverage: "complete",
      mutation: "none",
    });
  });

  it.each([
    "rg -n --hidden needle src",
    "grep -R -n --include '*.ts' needle src",
    "head -n 20 README.md",
    "tail --lines=20 --follow app.log",
    "wc -l src/index.ts",
    "ls -la --color=never src",
    "sed -n '1,20p' README.md",
    "sed -E 's/foo/bar/g' README.md",
    "find src -type f -name '*.ts' -print",
    "find . -maxdepth 2 -newermt '2026-01-01' -print0",
    "rg needle src | head -n 5",
  ])("recognizes a strictly parsed inspection command: %s", (source) => {
    expect(analyzeShellTargets(source)).toEqual({
      paths: [],
      coverage: "complete",
      mutation: "none",
    });
  });

  it.each([
    "git status --short",
    "git --no-pager diff --cached --name-only",
    "git -C repo log --oneline --max-count=10",
    "git rev-parse --show-toplevel",
    "git ls-files --cached --exclude-standard",
    "git add -- src/a.ts",
    "git commit -am 'record the fix'",
    "git commit --amend --no-edit",
    "git push --no-verify origin feature",
    "git branch --show-current",
    "git reset --mixed HEAD -- src/a.ts",
    "git restore --staged -- src/a.ts",
    "git rm --cached -- src/generated.ts",
    "gh pr view 42 --json state,mergeCommit",
    "gh pr create --title fix --body-file body.md --head feature",
    "gh pr edit 42 --add-label bug",
    "gh pr merge 42 --squash",
  ])("does not call static Git/ref/index/PR metadata a worktree edit: %s", (source) => {
    expect(analyzeShellTargets(source)).toEqual({
      paths: [],
      coverage: "complete",
      mutation: "none",
    });
  });

  it("still records output files produced by an otherwise read-only command", () => {
    expect(analyzeShellTargets("rg needle src > reports/matches.txt")).toEqual({
      paths: ["reports/matches.txt"],
      coverage: "complete",
      mutation: "present",
    });
  });

  it.each([
    'printf x > "$OUT"',
    "touch *.ts",
    "touch {a,b}",
    'printf "$(touch hidden)" > visible',
    'cat < "$FILE"',
    "cat < src/a.ts",
    'cat < "$(touch hidden)"',
    "./rm governed.ts",
    "rm -rf directory",
    "cp a b c",
    "cd src && touch a.ts",
    "for x in a; do touch $x; done",
  ])("marks the whole call unverified for unsupported or dynamic behavior: %s", (source) => {
    expect(analyzeShellTargets(source)).toMatchObject({
      coverage: "unverified",
      mutation: "present",
    });
  });

  it.each([
    "rg --pre 'touch pwned.ts' needle src",
    "rg --search-zip needle src",
    "rg --future-option needle src",
    "grep --unknown-option needle src",
    "sed -i.bak 's/a/b/' governed.ts",
    "sed 'w governed.ts' README.md",
    "sed 's/a/b/e' README.md",
    "find . -delete",
    "find . -exec touch governed.ts ';'",
    "find . -fprint governed.ts",
    "git -c alias.status='!touch governed.ts' status",
    "git diff --output=governed.patch",
    "git grep --open-files-in-pager=less needle",
    "git checkout -- governed.ts",
    "git restore governed.ts",
    "git reset --hard HEAD",
    "git clean -fd",
    "git stash push",
    "git apply governed.patch",
    "git commit --edit",
    "git push --exec=governed origin main",
    "gh pr checkout 42",
    "gh pr merge 42 --squash --delete-branch",
    "gh pr view 42 --web",
    "gh pr view 42 --unknown-option",
    "npm run build",
    "pnpm exec prettier --write governed.ts",
    "npx eslint --fix governed.ts",
  ])("fails closed for commands that may write, execute, or are not allowlisted: %s", (source) => {
    expect(analyzeShellTargets(source)).toMatchObject({
      coverage: "unverified",
      mutation: "present",
    });
  });

  it.each([
    'rg "$PATTERN" src',
    'git commit -m "$MESSAGE"',
    'gh pr create --title fix --body "$(touch governed.ts)"',
    "PATH=./bin git status --short",
  ])("fails closed for dynamic words and command prefixes: %s", (source) => {
    expect(analyzeShellTargets(source)).toMatchObject({
      coverage: "unverified",
      mutation: "present",
    });
  });

  it("retains known literal effects while marking an unsupported sibling unverified", () => {
    expect(analyzeShellTargets("printf x > known.ts; git restore other.ts")).toEqual({
      paths: ["known.ts"],
      coverage: "unverified",
      mutation: "present",
    });
  });

  it.each([
    "(touch governed.ts)",
    "if true; then touch governed.ts; fi",
    "for x in a; do touch governed.ts; done",
    "{ touch governed.ts; }",
    "echo $(touch governed.ts)",
  ])("retains known writes inside an unsupported AST: %s", (source) => {
    expect(analyzeShellTargets(source)).toEqual({
      paths: ["governed.ts"],
      coverage: "unverified",
      mutation: "present",
    });
  });

  it("marks command prefixes unverified but retains the literal target", () => {
    expect(analyzeShellTargets("PATH=./evil touch governed.ts")).toEqual({
      paths: ["governed.ts"],
      coverage: "unverified",
      mutation: "present",
    });
  });

  it("does not treat a function definition body as an executed write", () => {
    expect(analyzeShellTargets("f() { touch not-executed.ts; }")).toEqual({
      paths: [],
      coverage: "unverified",
      mutation: "present",
    });
  });

  it("extracts a quoted apply_patch heredoc as a definite edit", () => {
    expect(
      analyzeShellTargets(
        [
          "apply_patch <<'PATCH'",
          "*** Begin Patch",
          "*** Update File: src/quoted.ts",
          "*** End Patch",
          "PATCH",
        ].join("\n"),
      ),
    ).toEqual({
      paths: ["src/quoted.ts"],
      coverage: "complete",
      mutation: "present",
      definiteEdit: true,
    });
  });

  it("extracts a pure-literal unquoted apply_patch heredoc", () => {
    expect(
      analyzeShellTargets(
        [
          "apply_patch <<PATCH",
          "*** Begin Patch",
          "*** Update File: src/unquoted.ts",
          "*** End Patch",
          "PATCH",
        ].join("\n"),
      ),
    ).toEqual({
      paths: ["src/unquoted.ts"],
      coverage: "complete",
      mutation: "present",
      definiteEdit: true,
    });
  });

  it.each([
    [
      "an expansion-bearing body",
      [
        "apply_patch <<PATCH",
        "*** Begin Patch",
        "*** Update File: $TARGET",
        "*** End Patch",
        "PATCH",
      ].join("\n"),
    ],
    ["a markerless body", ["apply_patch <<'PATCH'", "not a patch", "PATCH"].join("\n")],
    ["argv-delivered input", "apply_patch '*** Update File: src/argv.ts'"],
  ])("marks %s unverified while retaining the definite-edit signal", (_name, source) => {
    expect(analyzeShellTargets(source)).toEqual({
      paths: [],
      coverage: "unverified",
      mutation: "present",
      definiteEdit: true,
    });
  });

  it("retains apply_patch paths alongside later shell edits", () => {
    expect(
      analyzeShellTargets(
        [
          "apply_patch <<'PATCH'",
          "*** Begin Patch",
          "*** Update File: src/patch.ts",
          "*** End Patch",
          "PATCH",
          "printf x > src/output.ts",
        ].join("\n"),
      ),
    ).toEqual({
      paths: ["src/patch.ts", "src/output.ts"],
      coverage: "complete",
      mutation: "present",
      definiteEdit: true,
    });
  });

  it.each([
    [
      "a path-prefixed command",
      ["./apply_patch <<'PATCH'", "*** Update File: src/prefixed.ts", "PATCH"].join("\n"),
    ],
    [
      "a tab-stripped heredoc",
      [
        "apply_patch <<-PATCH",
        "\t*** Begin Patch",
        "\t*** Update File: src/tabbed.ts",
        "\t*** End Patch",
        "\tPATCH",
      ].join("\n"),
    ],
  ])("keeps %s on the generic non-definite path", (_name, source) => {
    expect(analyzeShellTargets(source)).toEqual({
      paths: [],
      coverage: "unverified",
      mutation: "present",
    });
  });

  it("treats malformed syntax as unverified instead of throwing", () => {
    expect(analyzeShellTargets("if then (")).toEqual({
      paths: [],
      coverage: "unverified",
      mutation: "present",
    });
  });
});
