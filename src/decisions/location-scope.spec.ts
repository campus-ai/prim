import { describe, expect, it } from "vitest";
import {
  LocationScopeInputError,
  isScopeBranchPattern,
  locationScopeFromOptions,
  normalizeScopeDirectory,
  scopeBranches,
  scopeDirectories,
  scopeGlobs,
} from "./location-scope.js";

const numbered = (count: number, name: (index: number) => string): string[] =>
  Array.from({ length: count }, (_, index) => name(index));

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
    [".//", ""],
    ["/", ""],
    ["", ""],
  ])("rewrites nothing else in %j", (typed, result) => {
    expect(normalizeScopeDirectory(typed)).toBe(result);
  });

  it("stays linear on a long run of slashes that does not end the value", () => {
    const slashes = "/".repeat(200_000);

    expect(normalizeScopeDirectory(`docs${slashes}x`)).toBe(`docs${slashes}x`);
    expect(normalizeScopeDirectory(`docs${slashes}`)).toBe("docs");
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

  it.each(["/etc", "docs/../secrets", "", "..", "././docs", "docs\\ga", "docs\nga", "/"])(
    "refuses %j by the value as typed",
    (value) => {
      expect(() => scopeDirectories(["docs", value])).toThrow(LocationScopeInputError);
      expect(() => scopeDirectories(["docs", value])).toThrow(
        `--scope-dir ${JSON.stringify(value)} is not a repository-relative directory; use a path such as docs/ga: no leading "/", no "\\", no control character, no empty, "." or ".." segment, at most 4096 characters`,
      );
    },
  );

  it.each([".", "./", ".//", "./."])("points %j at --scope-repo", (value) => {
    expect(() => scopeDirectories([value])).toThrow(
      new LocationScopeInputError(
        `--scope-dir ${JSON.stringify(value)} names the repository root; use --scope-repo to govern the whole repository`,
      ),
    );
  });

  it("accepts a directory at the length limit and refuses one past it", () => {
    expect(scopeDirectories(["a".repeat(4096)])).toEqual(["a".repeat(4096)]);
    expect(() => scopeDirectories(["a".repeat(4097)])).toThrow(
      `--scope-dir "${"a".repeat(79)}…" is not a repository-relative directory`,
    );
  });
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
        `--scope-glob ${JSON.stringify(value)} is not an accepted glob; use a repository-relative pattern such as src/**/*.ts: no leading "/", no control character, no empty, "." or ".." segment, none of [ ] { } ! ( ) \\ ~ $ \`, at most 4096 characters`,
      );
    },
  );
});

describe("isScopeBranchPattern", () => {
  it.each(["main", "release/*", "feat/a b", "/odd", "..", "a".repeat(255)])(
    "accepts %j",
    (value) => {
      expect(isScopeBranchPattern(value)).toBe(true);
    },
  );

  it.each(["", "a".repeat(256), "main\n", "ma\tin", "main\u007f", "\u0000"])(
    "rejects %j",
    (value) => {
      expect(isScopeBranchPattern(value)).toBe(false);
    },
  );
});

describe("scopeBranches", () => {
  it("returns accepted patterns unchanged", () => {
    expect(scopeBranches(["main", "release/*"])).toEqual(["main", "release/*"]);
  });

  it.each(["", "main\n"])("refuses %j by the value as typed", (value) => {
    expect(() => scopeBranches(["main", value])).toThrow(
      new LocationScopeInputError(
        `--scope-branch ${JSON.stringify(value)} is not an accepted branch pattern; use a name or pattern such as main or release/*: not empty, no control character, at most 255 characters`,
      ),
    );
  });

  it("refuses a pattern past the length limit and shows only its start", () => {
    expect(() => scopeBranches(["b".repeat(256)])).toThrow(
      `--scope-branch "${"b".repeat(79)}…" is not an accepted branch pattern`,
    );
  });
});

describe("locationScopeFromOptions", () => {
  it("returns undefined when no selector was given", () => {
    expect(locationScopeFromOptions({})).toBeUndefined();
    expect(
      locationScopeFromOptions({ scopeDir: [], scopeGlob: [], scopeBranch: [] }),
    ).toBeUndefined();
  });

  it("builds the wire scope from every flag", () => {
    expect(
      locationScopeFromOptions({
        scopeRepo: true,
        scopeDir: ["packages/api/", "./apps/web"],
        scopeGlob: ["src/**/*.test.ts"],
        scopeBranch: ["main"],
      }),
    ).toEqual({
      repository: true,
      directories: ["packages/api", "apps/web"],
      globs: ["src/**/*.test.ts"],
      branches: ["main"],
    });
  });

  it("accepts 25 distinct selectors and refuses a 26th", () => {
    const directories = numbered(12, (index) => `dir-${index}`);
    const globs = numbered(12, (index) => `glob-${index}/**`);

    expect(
      locationScopeFromOptions({ scopeRepo: true, scopeDir: directories, scopeGlob: globs }),
    ).toMatchObject({ repository: true, directories, globs });
    expect(() =>
      locationScopeFromOptions({
        scopeRepo: true,
        scopeDir: [...directories, "dir-extra"],
        scopeGlob: globs,
      }),
    ).toThrow(
      new LocationScopeInputError(
        "--scope-repo, --scope-dir and --scope-glob name 26 distinct selectors; a Decision allows at most 25",
      ),
    );
    expect(() =>
      locationScopeFromOptions({ scopeDir: numbered(26, (index) => `dir-${index}`) }),
    ).toThrow("name 26 distinct selectors; a Decision allows at most 25");
  });

  it("counts repeats once, as the server does, including spellings of one directory", () => {
    const directories = numbered(25, (index) => `dir-${index}`);

    expect(
      locationScopeFromOptions({ scopeDir: [...directories, "dir-0/", "./dir-1", "dir-2"] }),
    ).toMatchObject({ directories: [...directories, "dir-0", "dir-1", "dir-2"] });
  });

  it("accepts 25 distinct branch patterns and refuses a 26th", () => {
    const branches = numbered(25, (index) => `release/${index}`);

    expect(locationScopeFromOptions({ scopeBranch: [...branches, "release/0"] })).toEqual({
      branches: [...branches, "release/0"],
    });
    expect(() => locationScopeFromOptions({ scopeBranch: [...branches, "main"] })).toThrow(
      new LocationScopeInputError(
        "--scope-branch names 26 distinct branch patterns; a Decision allows at most 25",
      ),
    );
  });

  it("does not count branch patterns against the selector limit", () => {
    expect(
      locationScopeFromOptions({
        scopeDir: numbered(25, (index) => `dir-${index}`),
        scopeBranch: numbered(25, (index) => `release/${index}`),
      }),
    ).toBeDefined();
  });
});
