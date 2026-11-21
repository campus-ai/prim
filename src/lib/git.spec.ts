import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  declaredGithubRepository,
  githubRepositoryFullName,
  normalizeOriginRemote,
  resolveRepositoryContext,
} from "./git.js";

const CLOUD = { CLAUDE_CODE_REMOTE: "true" } as const;
const PROXY_ORIGIN = "http://local_proxy@127.0.0.1:41337/git/campus-ai/prim";

const roots: string[] = [];

function repo(origin?: string): string {
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
  if (origin) git("remote", "add", "origin", origin);
  return root;
}

beforeEach(() => {
  // A developer running the suite inside a cloud session must not leak its
  // own session markers into these cases.
  vi.stubEnv("CLAUDE_CODE_REMOTE", "");
  vi.stubEnv("PRIM_REPOSITORY", "");
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
    expect(githubRepositoryFullName(repo(origin), {})).toBe("campus-ai/prim");
  });

  it("reads the Claude Code cloud git proxy origin inside a cloud session", () => {
    expect(githubRepositoryFullName(repo(PROXY_ORIGIN), CLOUD)).toBe("campus-ai/prim");
    expect(githubRepositoryFullName(repo(`${PROXY_ORIGIN}.git`), CLOUD)).toBe("campus-ai/prim");
  });

  it("ignores a loopback proxy origin outside a cloud session", () => {
    expect(githubRepositoryFullName(repo(PROXY_ORIGIN), {})).toBeNull();
    expect(githubRepositoryFullName(repo(PROXY_ORIGIN), { CLAUDE_CODE_REMOTE: "1" })).toBeNull();
  });

  it.each([
    "https://local_proxy@127.0.0.1:41337/git/campus-ai/prim",
    "http://someone@127.0.0.1:41337/git/campus-ai/prim",
    "http://local_proxy:pw@127.0.0.1:41337/git/campus-ai/prim",
    "http://local_proxy@example.com:41337/git/campus-ai/prim",
    "http://local_proxy@127.0.0.1/git/campus-ai/prim",
    "http://local_proxy@127.0.0.1:41337/campus-ai/prim",
    "http://local_proxy@127.0.0.1:41337/git/campus-ai/prim/extra",
    "http://local_proxy@127.0.0.1:41337/git/campus-ai/prim?x=1",
    "http://local_proxy@127.0.0.1:41337/git/-bad/prim",
  ])("rejects a near-miss proxy origin: %s", (origin) => {
    expect(githubRepositoryFullName(repo(origin), CLOUD)).toBeNull();
  });

  it("falls back to a declared PRIM_REPOSITORY when origin is missing", () => {
    expect(githubRepositoryFullName(repo(), { PRIM_REPOSITORY: "campus-ai/prim" })).toBe(
      "campus-ai/prim",
    );
  });

  it("falls back to a declared PRIM_REPOSITORY when origin is not GitHub", () => {
    const root = repo("https://gitlab.example.com/team/prim.git");
    expect(githubRepositoryFullName(root, { PRIM_REPOSITORY: "campus-ai/prim" })).toBe(
      "campus-ai/prim",
    );
  });

  it("prefers a GitHub origin over a conflicting declaration", () => {
    const root = repo("https://github.com/campus-ai/prim.git");
    expect(githubRepositoryFullName(root, { PRIM_REPOSITORY: "campus-ai/other" })).toBe(
      "campus-ai/prim",
    );
  });

  it("returns null without origin or a valid declaration", () => {
    expect(githubRepositoryFullName(repo(), {})).toBeNull();
    expect(githubRepositoryFullName(repo(), { PRIM_REPOSITORY: "not a repo" })).toBeNull();
  });
});

describe("declaredGithubRepository", () => {
  it.each([
    ["campus-ai/prim", "campus-ai/prim"],
    [" campus-ai/prim.git ", "campus-ai/prim"],
    ["campus-ai", null],
    ["campus-ai/prim/extra", null],
    ["https://github.com/campus-ai/prim", null],
    ["", null],
  ])("parses %j", (value, expected) => {
    expect(declaredGithubRepository({ PRIM_REPOSITORY: value })).toBe(expected);
  });
});

describe("normalizeOriginRemote", () => {
  it("keys a cloud proxy origin as its github.com clone, independent of port", () => {
    expect(normalizeOriginRemote(PROXY_ORIGIN, CLOUD)).toBe("github.com/campus-ai/prim");
    expect(
      normalizeOriginRemote("http://local_proxy@127.0.0.1:25968/git/campus-ai/prim", CLOUD),
    ).toBe(normalizeOriginRemote("https://github.com/campus-ai/prim.git", CLOUD));
  });

  it("keeps a loopback origin machine-specific outside a cloud session", () => {
    expect(normalizeOriginRemote(PROXY_ORIGIN, {})).toBe("127.0.0.1:41337/git/campus-ai/prim");
  });
});

describe("resolveRepositoryContext", () => {
  const laptopKey = () =>
    resolveRepositoryContext(repo("https://github.com/campus-ai/prim.git"))?.repoKey;

  it("gives a cloud proxy clone the same identity as a developer clone", () => {
    const expected = laptopKey();
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const context = resolveRepositoryContext(repo(PROXY_ORIGIN));
    expect(context).toMatchObject({ identitySource: "origin", repoFullName: "campus-ai/prim" });
    expect(context?.repoKey).toBe(expected);
  });

  it("gives an origin-less declared clone the same identity as a developer clone", () => {
    const expected = laptopKey();
    vi.stubEnv("PRIM_REPOSITORY", "campus-ai/prim");
    const context = resolveRepositoryContext(repo());
    expect(context).toMatchObject({ identitySource: "origin", repoFullName: "campus-ai/prim" });
    expect(context?.repoKey).toBe(expected);
  });

  it("still keys an undeclared origin-less clone by its root commit", () => {
    expect(resolveRepositoryContext(repo())?.identitySource).toBe("root_commit");
  });
});
