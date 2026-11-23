import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  declaredGithubRepository,
  githubRepositoryFullName,
  originGithubRepository,
  originIdentifiesRepository,
  parseGithubRepositoryName,
  resolveRepositoryContext,
} from "./git.js";

const roots: string[] = [];

function repo(options: { origin?: string; declared?: unknown } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "prim-git-"));
  roots.push(root);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: ["ignore", "ignore", "pipe"] });
  git("init", "--quiet");
  git(
    "-c",
    "user.name=t",
    "-c",
    "user.email=t@example.com",
    "commit",
    "--quiet",
    "--allow-empty",
    "-m",
    "root",
  );
  if (options.origin) git("remote", "add", "origin", options.origin);
  if (options.declared !== undefined) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      JSON.stringify({ env: { PRIM_REPOSITORY: options.declared } }),
    );
  }
  return root;
}

beforeEach(() => {
  // A declaration in the environment must never count, so set one everywhere.
  vi.stubEnv("PRIM_REPOSITORY", "env-owner/env-repo");
  // Fixture commits must not inherit the host's git config: a signing agent
  // (commit.gpgsign) makes them slow, interactive, or failing.
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
});

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("githubRepositoryFullName", () => {
  it.each([
    "https://github.com/campus-ai/prim.git",
    "git@github.com:campus-ai/prim.git",
    "ssh://git@github.com/campus-ai/prim",
  ])("reads a github.com origin: %s", (origin) => {
    expect(githubRepositoryFullName(repo({ origin }))).toBe("campus-ai/prim");
  });

  it("reads the checkout's own committed declaration when it has no origin", () => {
    expect(githubRepositoryFullName(repo({ declared: "campus-ai/prim" }))).toBe("campus-ai/prim");
  });

  it("never takes a declaration from the environment", () => {
    expect(githubRepositoryFullName(repo())).toBeNull();
  });

  it("prefers a GitHub origin over a conflicting declaration", () => {
    const root = repo({ origin: "https://github.com/campus-ai/prim.git", declared: "other/name" });
    expect(githubRepositoryFullName(root)).toBe("campus-ai/prim");
  });

  it("ignores a declaration when a non-GitHub origin already identifies the repository", () => {
    const root = repo({
      origin: "https://gitlab.example.com/team/prim.git",
      declared: "campus-ai/prim",
    });
    expect(githubRepositoryFullName(root)).toBeNull();
  });

  it.each([["not a repo"], ["campus-ai/.."], ["campus-ai/."], [42]])(
    "rejects the invalid declaration %j",
    (declared) => {
      expect(githubRepositoryFullName(repo({ declared }))).toBeNull();
    },
  );
});

describe("declaration edge cases", () => {
  it("applies when origin cannot identify the repository (a local-path origin)", () => {
    const root = repo({ origin: "/srv/mirrors/prim.git", declared: "campus-ai/prim" });
    expect(githubRepositoryFullName(root)).toBe("campus-ai/prim");
    expect(resolveRepositoryContext(root)?.identitySource).toBe("declared");
  });

  it("resolves from a subdirectory of the checkout", () => {
    const root = repo({ declared: "campus-ai/prim" });
    mkdirSync(join(root, "src", "lib"), { recursive: true });
    expect(githubRepositoryFullName(join(root, "src", "lib"))).toBe("campus-ai/prim");
  });

  it.each([
    ["env is an array", JSON.stringify({ env: ["campus-ai/prim"] })],
    ["env is null", JSON.stringify({ env: null })],
    ["top level is an array", JSON.stringify([{ env: { PRIM_REPOSITORY: "campus-ai/prim" } }])],
    ["malformed JSON", "{ env: "],
  ])("ignores settings where %s", (_label, content) => {
    const root = repo();
    mkdirSync(join(root, ".claude"));
    writeFileSync(join(root, ".claude", "settings.json"), content);
    expect(githubRepositoryFullName(root)).toBeNull();
  });

  it("refuses a symlinked settings file that could borrow another checkout's identity", () => {
    const other = repo({ declared: "campus-ai/prim" });
    const root = repo();
    mkdirSync(join(root, ".claude"));
    symlinkSync(join(other, ".claude", "settings.json"), join(root, ".claude", "settings.json"));
    expect(githubRepositoryFullName(root)).toBeNull();
  });
});

describe("originIdentifiesRepository", () => {
  it("is true exactly when a declaration would be ignored", () => {
    expect(originIdentifiesRepository(repo({ origin: "git@github.com:campus-ai/prim.git" }))).toBe(
      true,
    );
    expect(originIdentifiesRepository(repo({ origin: "https://gitlab.example.com/t/p.git" }))).toBe(
      true,
    );
    expect(originIdentifiesRepository(repo({ origin: "/srv/mirrors/prim.git" }))).toBe(false);
    expect(originIdentifiesRepository(repo())).toBe(false);
  });
});

describe("hostile settings paths", () => {
  it("refuses a symlinked .claude directory", () => {
    const other = repo({ declared: "campus-ai/prim" });
    const root = repo();
    symlinkSync(join(other, ".claude"), join(root, ".claude"));
    expect(githubRepositoryFullName(root)).toBeNull();
  });

  it("refuses an oversized settings file", () => {
    const root = repo();
    mkdirSync(join(root, ".claude"));
    const padding = " ".repeat(1024 * 1024);
    writeFileSync(
      join(root, ".claude", "settings.json"),
      `{"env":{"PRIM_REPOSITORY":"campus-ai/prim"}}${padding}`,
    );
    expect(githubRepositoryFullName(root)).toBeNull();
  });
});

describe("originGithubRepository", () => {
  it("names only what origin says, ignoring any declaration", () => {
    expect(originGithubRepository(repo({ declared: "campus-ai/prim" }))).toBeNull();
    expect(originGithubRepository(repo({ origin: "git@github.com:campus-ai/prim.git" }))).toBe(
      "campus-ai/prim",
    );
  });
});

describe("declaredGithubRepository", () => {
  it("reads only the given checkout's settings file", () => {
    const declared = repo({ declared: "campus-ai/prim" });
    expect(declaredGithubRepository(declared)).toBe("campus-ai/prim");
    expect(declaredGithubRepository(repo())).toBeNull();
  });
});

describe("parseGithubRepositoryName", () => {
  it.each([
    ["campus-ai/prim", "campus-ai/prim"],
    ["campus-ai/prim.git", "campus-ai/prim"],
    ["campus-ai/.github", "campus-ai/.github"],
    ["campus-ai/..", null],
    ["campus-ai/.", null],
    ["campus-ai", null],
    ["campus-ai/prim/extra", null],
  ])("parses %j", (value, expected) => {
    expect(parseGithubRepositoryName(value)).toBe(expected);
  });
});

describe("resolveRepositoryContext", () => {
  const laptopKey = () =>
    resolveRepositoryContext(repo({ origin: "https://github.com/campus-ai/prim.git" }))?.repoKey;

  it("keys an origin-less declared checkout exactly as its developer clone", () => {
    const expected = laptopKey();
    const context = resolveRepositoryContext(repo({ declared: "campus-ai/prim" }));
    expect(context).toMatchObject({ identitySource: "declared", repoFullName: "campus-ai/prim" });
    expect(context?.repoKey).toBe(expected);
  });

  it("keeps a non-GitHub origin's key and name consistent despite a declaration", () => {
    const context = resolveRepositoryContext(
      repo({ origin: "https://gitlab.example.com/team/prim.git", declared: "campus-ai/prim" }),
    );
    expect(context?.identitySource).toBe("origin");
    expect(context?.repoFullName).toBeUndefined();
    expect(context?.repoKey).not.toBe(laptopKey());
  });

  it("keys an undeclared origin-less checkout by its root commit, whatever the environment says", () => {
    expect(resolveRepositoryContext(repo())).toMatchObject({
      identitySource: "root_commit",
      repoFullName: undefined,
    });
  });
});
