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

  it("treats malformed syntax as unverified instead of throwing", () => {
    expect(analyzeShellTargets("if then (")).toEqual({
      paths: [],
      coverage: "unverified",
      mutation: "present",
    });
  });
});
