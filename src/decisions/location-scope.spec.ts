import { describe, expect, it } from "vitest";
import {
  LocationScopeInputError,
  isCanonicalScopeDirectory,
  isCanonicalScopeGlob,
  normalizeScopeDirectory,
  scopeDirectories,
  scopeGlobs,
} from "./location-scope.js";

describe("normalizeScopeDirectory", () => {
  it.each([
    ["docs/ga/", "docs/ga"],
    ["docs/ga///", "docs/ga"],
    ["./docs/ga", "docs/ga"],
    ["./docs/ga/", "docs/ga"],
    ["docs/ga", "docs/ga"],
    ["docs", "docs"],
    [".github", ".github"],
  ])("maps %s to %s", (typed, sent) => {
    expect(normalizeScopeDirectory(typed)).toBe(sent);
  });

  it.each([
    ["././docs", "./docs"],
    ["docs/./ga", "docs/./ga"],
    ["docs//ga", "docs//ga"],
    [" docs/ga", " docs/ga"],
    ["/docs/", "/docs"],
    ["./", ""],
    ["/", ""],
  ])("rewrites nothing else in %j", (typed, result) => {
    expect(normalizeScopeDirectory(typed)).toBe(result);
  });
});

describe("isCanonicalScopeDirectory", () => {
  it.each(["docs", "docs/ga", ".github/workflows", "a b/c", "packages/api-v2", "a".repeat(4096)])(
    "accepts %s",
    (value) => {
      expect(isCanonicalScopeDirectory(value)).toBe(true);
    },
  );

  it.each([
    "",
    "/",
    "/docs",
    "docs/",
    "docs//ga",
    ".",
    "./docs",
    "docs/./ga",
    "..",
    "../docs",
    "docs/..",
    "docs\\ga",
    "docs\nga",
    "docs\u007fga",
    "a".repeat(4097),
  ])("rejects %j", (value) => {
    expect(isCanonicalScopeDirectory(value)).toBe(false);
  });
});

describe("isCanonicalScopeGlob", () => {
  it.each(["**", "**/*.sql", "src/**/*.test.ts", "docs/?.md", "*.md", "a b/*", "a".repeat(4096)])(
    "accepts %s",
    (value) => {
      expect(isCanonicalScopeGlob(value)).toBe(true);
    },
  );

  it.each([
    "",
    "/src/**",
    "src/**/",
    "src//*.ts",
    "./src/**",
    "src/../**",
    "src/*.{ts,tsx}",
    "src/[ab].ts",
    "!src/**",
    "src/(a).ts",
    "src\\*.ts",
    "~/src/**",
    "$HOME/**",
    "src/`x`",
    "src/\t*.ts",
    "a".repeat(4097),
  ])("rejects %j", (value) => {
    expect(isCanonicalScopeGlob(value)).toBe(false);
  });
});

describe("scopeDirectories", () => {
  it("returns each directory in the form the server accepts", () => {
    expect(scopeDirectories(["docs/ga/", "./packages/api", "apps/web"])).toEqual([
      "docs/ga",
      "packages/api",
      "apps/web",
    ]);
  });

  it.each(["/etc", "docs/../secrets", "", "./", "..", "././docs", "docs\\ga"])(
    "refuses %j by the value as typed",
    (value) => {
      expect(() => scopeDirectories(["docs", value])).toThrow(LocationScopeInputError);
      expect(() => scopeDirectories(["docs", value])).toThrow(
        `--scope-dir ${JSON.stringify(value)} is not a repository-relative directory`,
      );
    },
  );
});

describe("scopeGlobs", () => {
  it("returns accepted globs unchanged", () => {
    expect(scopeGlobs(["**/*.sql", "src/**/*.test.ts"])).toEqual(["**/*.sql", "src/**/*.test.ts"]);
  });

  it.each(["./src/**", "src/**/", "/src/**", "src/*.{ts,tsx}", ""])(
    "refuses %j without rewriting it",
    (value) => {
      expect(() => scopeGlobs(["**/*.sql", value])).toThrow(LocationScopeInputError);
      expect(() => scopeGlobs(["**/*.sql", value])).toThrow(
        `--scope-glob ${JSON.stringify(value)} is not an accepted glob`,
      );
    },
  );
});
