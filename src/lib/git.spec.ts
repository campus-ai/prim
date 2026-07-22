import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { canonicalGitRoot, canonicalRepositoryPath, githubRepositoryFullName } from "./git.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prim-git-v3-"));
  execFileSync("git", ["init", "-q", root]);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("githubRepositoryFullName", () => {
  it.each([
    "git@github.com:campus-ai/primitive.git",
    "https://token@github.com/campus-ai/primitive.git",
    "ssh://git@github.com/campus-ai/primitive.git",
  ])("accepts a credential-free GitHub owner/name from %s", (remote) => {
    execFileSync("git", ["-C", root, "remote", "add", "origin", remote]);
    expect(githubRepositoryFullName(root)).toBe("campus-ai/primitive");
  });

  it.each([
    "http://github.com/campus-ai/primitive.git",
    "https://gitlab.com/campus-ai/primitive.git",
    "https://github.com/group/nested/primitive.git",
  ])("rejects unsupported repository identity %s", (remote) => {
    execFileSync("git", ["-C", root, "remote", "add", "origin", remote]);
    expect(githubRepositoryFullName(root)).toBeNull();
  });
});

describe("canonicalRepositoryPath", () => {
  it("canonicalizes an existing file and an exact new leaf", () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "old.ts"), "x");
    const canonicalRoot = canonicalGitRoot(root);
    expect(canonicalRepositoryPath(join(root, "src", "old.ts"), root, canonicalRoot)).toBe(
      "src/old.ts",
    );
    expect(canonicalRepositoryPath("src/new.ts", root, canonicalRoot)).toBe("src/new.ts");
  });

  it("marks escaping, directory, symlink, missing-parent, and control paths invalid", () => {
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "target.ts"), "x");
    symlinkSync(join(root, "src", "target.ts"), join(root, "src", "link.ts"));
    const canonicalRoot = canonicalGitRoot(root);
    expect(canonicalRepositoryPath("../outside.ts", root, canonicalRoot)).toBeNull();
    for (const path of ["src", "src/link.ts", "missing/new.ts", "src/bad\nname.ts"]) {
      expect(canonicalRepositoryPath(path, root, canonicalRoot)).toBeNull();
    }
  });

  it("rejects glob, variable, and backslash syntax", () => {
    const canonicalRoot = canonicalGitRoot(root);
    for (const path of ["~/a.ts", "src/*.ts", "src/$OUT", "src/[ab].ts", "src\\a.ts"]) {
      expect(canonicalRepositoryPath(path, root, canonicalRoot)).toBeNull();
    }
  });

  it("resolves a new leaf through a physical parent and enforces containment", () => {
    const outside = mkdtempSync(join(tmpdir(), "prim-git-outside-"));
    try {
      mkdirSync(join(root, "inside"));
      symlinkSync(join(root, "inside"), join(root, "inside-link"));
      symlinkSync(outside, join(root, "outside-link"));
      const canonicalRoot = canonicalGitRoot(root);
      expect(canonicalRepositoryPath("inside-link/new.ts", root, canonicalRoot)).toBe(
        "inside/new.ts",
      );
      expect(canonicalRepositoryPath("outside-link/new.ts", root, canonicalRoot)).toBeNull();
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });
});
