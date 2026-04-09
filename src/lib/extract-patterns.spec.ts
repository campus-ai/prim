import { describe, expect, it } from "vitest";
import { extractPatterns } from "./extract-patterns.js";

describe("extractPatterns", () => {
  it("returns empty array for empty text", () => {
    expect(extractPatterns("")).toEqual([]);
  });

  it("returns empty array for text with no paths", () => {
    expect(extractPatterns("This is a spec about authentication.")).toEqual([]);
  });

  // Glob patterns
  it("preserves glob patterns verbatim", () => {
    expect(extractPatterns("Watch `src/**/*.ts` for changes")).toEqual(["src/**/*.ts"]);
  });

  it("preserves directory glob patterns", () => {
    expect(extractPatterns("Map src/auth/**")).toEqual(["src/auth/**"]);
  });

  // Directory references
  it("converts directory references to globs", () => {
    expect(extractPatterns("Files in src/auth/ are affected")).toEqual(["src/auth/**"]);
  });

  it("handles multiple directory references", () => {
    const result = extractPatterns("Check src/auth/ and src/oauth/ for changes");
    expect(result).toEqual(["src/auth/**", "src/oauth/**"]);
  });

  // File paths
  it("converts file paths to directory-level globs", () => {
    expect(extractPatterns("Edit src/auth/login.ts to fix the bug")).toEqual(["src/auth/**"]);
  });

  it("deduplicates files in the same directory", () => {
    const text = "Modify src/auth/login.ts and src/auth/register.ts";
    expect(extractPatterns(text)).toEqual(["src/auth/**"]);
  });

  it("handles deeply nested paths", () => {
    expect(extractPatterns("See src/auth/middleware/validate.ts")).toEqual([
      "src/auth/middleware/**",
    ]);
  });

  // Paths in various delimiters
  it("extracts paths in backticks", () => {
    expect(extractPatterns("Update `src/auth/login.ts` file")).toEqual(["src/auth/**"]);
  });

  it("extracts paths in double quotes", () => {
    expect(extractPatterns('Update "src/auth/login.ts" file')).toEqual(["src/auth/**"]);
  });

  it("extracts paths in single quotes", () => {
    expect(extractPatterns("Update 'src/auth/login.ts' file")).toEqual(["src/auth/**"]);
  });

  // Path without extension treated as directory
  it("treats paths without extension as directories", () => {
    expect(extractPatterns("The src/auth module handles login")).toEqual(["src/auth/**"]);
  });

  // Leading ./ stripped
  it("strips leading ./", () => {
    expect(extractPatterns("Edit ./src/auth/login.ts")).toEqual(["src/auth/**"]);
  });

  // False positive filtering
  it("filters out URLs", () => {
    expect(extractPatterns("See https://example.com/path/file.ts")).toEqual([]);
  });

  it("filters out absolute paths", () => {
    expect(extractPatterns("Stored at /etc/config.ts")).toEqual([]);
  });

  it("filters out version strings", () => {
    expect(extractPatterns("Uses HTTP/2 and TLS/1.3 protocols")).toEqual([]);
  });

  it("filters out date-like patterns", () => {
    expect(extractPatterns("Created on 2024/01/15")).toEqual([]);
  });

  it("filters out common abbreviations", () => {
    expect(extractPatterns("N/A or w/o changes and/or updates")).toEqual([]);
  });

  it("filters out package-only references", () => {
    expect(extractPatterns("Install @scope/package for this")).toEqual([]);
  });

  it("keeps scoped package paths with deeper segments", () => {
    expect(extractPatterns("Edit @scope/package/src/index.ts")).toEqual(["@scope/package/src/**"]);
  });

  // Mixed content
  it("extracts from mixed prose and code", () => {
    const text = `
## Authentication Module

This spec covers the auth system in \`src/auth/\`.
Key files:
- src/auth/login.ts
- src/auth/register.ts
- src/middleware/auth.ts

See https://docs.example.com for reference.
Use the pattern src/utils/**/*.ts for helpers.
    `;
    const result = extractPatterns(text);
    expect(result).toEqual(["src/auth/**", "src/middleware/**", "src/utils/**/*.ts"]);
  });
});
