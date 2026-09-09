import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  MAX_SCOPE_GLOB_CHARS,
  isScopeDirectoryPrefix,
  isScopeGlobPattern,
  matchesScopeGlob,
} from "./scope-glob.js";

type ScopeGlobVector = { pattern: string; path: string; matches: boolean };

const fixtures = JSON.parse(
  readFileSync(resolve(process.cwd(), "contracts/cli-http-v1.fixtures.json"), "utf-8"),
) as { scopeGlobVectors: ScopeGlobVector[] };

describe("scope glob grammar", () => {
  it.each(fixtures.scopeGlobVectors)("$pattern $matches $path", ({ pattern, path, matches }) => {
    expect(matchesScopeGlob(pattern, path)).toBe(matches);
  });

  it.each([
    "",
    "/src/**",
    "src//index.ts",
    "src/./index.ts",
    "src/../index.ts",
    "src/[a].ts",
    "src/{a,b}.ts",
    "src/!(test).ts",
    "src/\\name.ts",
    "src/~name.ts",
    "src/$name.ts",
    "src/`name.ts",
    "src/\u0000name.ts",
  ])("rejects unsupported pattern %j", (pattern) => {
    expect(isScopeGlobPattern(pattern)).toBe(false);
    expect(matchesScopeGlob(pattern, "src/name.ts")).toBe(false);
  });

  it("treats wildcard punctuation in a directory prefix literally", () => {
    expect(isScopeDirectoryPrefix("docs/reference")).toBe(true);
    expect(isScopeDirectoryPrefix("docs/*")).toBe(true);
    expect(isScopeDirectoryPrefix("docs/?")).toBe(true);
  });

  it("uses the server's bounded path grammar for both patterns and targets", () => {
    const tooLong = `a${"b".repeat(MAX_SCOPE_GLOB_CHARS)}`;
    expect(isScopeGlobPattern(tooLong)).toBe(false);
    expect(matchesScopeGlob("src/*.ts", tooLong)).toBe(false);
  });
});
