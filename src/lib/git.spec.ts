import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  canonicalGitRoot,
  canonicalRepositoryPath,
  githubRepositoryFullName,
  normalizeOriginRemote,
  resolveRepositoryContext,
} from "./git.js";

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
    "https://github.com/campus\u202e-ai/primitive.git",
    "https://github.com/campus-ai/pr\u200bimitive.git",
    "https://github.com/campus-ai/primitive%20name.git",
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

function git(cwd: string, ...args: string[]): void {
  execFileSync("git", args, { cwd, stdio: "ignore" });
}

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "prim-repo-context-"));
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "config", "commit.gpgsign", "false");
  writeFileSync(join(root, "README.md"), "test\n");
  git(root, "add", "README.md");
  git(root, "commit", "-qm", "init");
  return root;
}

describe("normalizeOriginRemote", () => {
  it("removes URL and SCP credentials without changing the repository path", () => {
    expect(normalizeOriginRemote("https://token@example.com/Org/Repo.git?x=1#fragment")).toBe(
      "example.com/Org/Repo",
    );
    expect(normalizeOriginRemote("git@GitHub.com:Org/Repo.git")).toBe("github.com/Org/Repo");
    expect(normalizeOriginRemote("https://github.com/Org/Repo.git")).toBe(
      normalizeOriginRemote("git@github.com:Org/Repo.git"),
    );
  });

  it("preserves explicit ports and bracketed IPv6 hosts", () => {
    expect(normalizeOriginRemote("https://token@example.com:8443/Org/Repo.git")).toBe(
      "example.com:8443/Org/Repo",
    );
    expect(normalizeOriginRemote("ssh://git@[2001:db8::1]:2222/Org/Repo.git")).toBe(
      "[2001:db8::1]:2222/Org/Repo",
    );
    expect(normalizeOriginRemote("https://example.com:8443/Org/Repo.git")).not.toBe(
      normalizeOriginRemote("https://example.com:9443/Org/Repo.git"),
    );
  });
});

describe("resolveRepositoryContext", () => {
  it("returns the same opaque key from a root and nested cwd", () => {
    const root = repository();
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    git(root, "remote", "add", "origin", "git@github.com:Org/Repo.git");
    const atRoot = resolveRepositoryContext(root);
    const nested = resolveRepositoryContext(join(root, "src", "nested"));
    expect(atRoot?.repoRoot).toBe(nested?.repoRoot);
    expect(atRoot?.repoKey).toBe(nested?.repoKey);
    expect(atRoot?.repoKey).toMatch(/^repo_v1_[a-f0-9]{64}$/);
    expect(atRoot?.repoFullName).toBe("Org/Repo");
  });

  it("does not change the fallback identity when an unrelated root ref is added", () => {
    const root = repository();
    const branch = execFileSync("git", ["branch", "--show-current"], {
      cwd: root,
      encoding: "utf-8",
    }).trim();
    const before = resolveRepositoryContext(root);

    git(root, "checkout", "--orphan", "unrelated-root");
    writeFileSync(join(root, "UNRELATED.md"), "other history\n");
    git(root, "add", "UNRELATED.md");
    git(root, "commit", "-qm", "unrelated root");
    git(root, "checkout", "-q", branch);

    const after = resolveRepositoryContext(root);
    expect(before?.identitySource).toBe("root_commit");
    expect(after?.identitySource).toBe("root_commit");
    expect(after?.repoKey).toBe(before?.repoKey);
  });
});

describe("canonicalRepositoryPath", () => {
  it("uses the git root rather than the session cwd", () => {
    const root = repository();
    mkdirSync(join(root, "src", "nested"), { recursive: true });
    const context = resolveRepositoryContext(join(root, "src"));
    if (!context) throw new Error("repository context missing");
    expect(canonicalRepositoryPath("nested/new.ts", context, join(root, "src"))).toEqual({
      ok: true,
      file: "src/nested/new.ts",
    });
  });

  it("rejects lexical and symlink escapes", () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "prim-outside-"));
    symlinkSync(outside, join(root, "escape"));
    const context = resolveRepositoryContext(root);
    if (!context) throw new Error("repository context missing");
    expect(canonicalRepositoryPath("../outside.ts", context, root)).toEqual({
      ok: false,
      reason: "outside_repository",
    });
    expect(canonicalRepositoryPath("escape/secret.ts", context, root)).toEqual({
      ok: false,
      reason: "outside_repository",
    });
  });

  it("rejects dangling symlinks instead of skipping them as nonexistent ancestors", () => {
    const root = repository();
    const outside = mkdtempSync(join(tmpdir(), "prim-outside-"));
    symlinkSync(join(outside, "missing.ts"), join(root, "dangling-file"));
    symlinkSync(join(outside, "missing-dir"), join(root, "dangling-dir"));
    const context = resolveRepositoryContext(root);
    if (!context) throw new Error("repository context missing");

    expect(canonicalRepositoryPath("dangling-file", context, root)).toEqual({
      ok: false,
      reason: "invalid_path",
    });
    expect(canonicalRepositoryPath("dangling-dir/child.ts", context, root)).toEqual({
      ok: false,
      reason: "invalid_path",
    });
  });

  it("rejects boundary-whitespace paths instead of silently changing their identity", () => {
    const root = repository();
    const context = resolveRepositoryContext(root);
    if (!context) throw new Error("repository context missing");
    expect(canonicalRepositoryPath("src/a ", context, root)).toEqual({
      ok: false,
      reason: "invalid_path",
    });
  });
});
