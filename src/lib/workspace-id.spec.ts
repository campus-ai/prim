import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getOrCreateWorkspaceId,
  inspectWorkspaceId,
  isCanonicalWorkspaceId,
} from "./workspace-id.js";

const execFileAsync = promisify(execFile);
const KNOWN_UUID = "123e4567-e89b-42d3-a456-426614174000";

describe.sequential("worktree workspace identity", () => {
  let scratch: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "prim-workspace-id-"));
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("creates one canonical ID at Git's per-worktree path", () => {
    const repo = initRepo(join(scratch, "repo"));
    const nested = join(repo, "src", "deep");
    mkdirSync(nested, { recursive: true });

    const result = getOrCreateWorkspaceId(nested);
    expect(result.status).toBe("ready");
    if (result.status !== "ready") return;

    expect(result.created).toBe(true);
    expect(isCanonicalWorkspaceId(result.workspaceId)).toBe(true);
    expect(result.path).toBe(gitWorkspaceIdPath(nested));
    expect(readFileSync(result.path, "utf8")).toBe(`${result.workspaceId}\n`);
    expect(statSync(dirname(result.path)).mode & 0o777).toBe(0o700);
    expect(statSync(result.path).mode & 0o777).toBe(0o600);
  });

  it("preserves an existing valid ID", () => {
    const repo = initRepo(join(scratch, "repo"));
    const path = gitWorkspaceIdPath(repo);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${KNOWN_UUID}\n`, { mode: 0o600 });

    expect(getOrCreateWorkspaceId(repo)).toEqual({
      status: "ready",
      workspaceId: KNOWN_UUID,
      path,
      created: false,
    });
    expect(readFileSync(path, "utf8")).toBe(`${KNOWN_UUID}\n`);
  });

  it("inspects a missing ID without creating it", () => {
    const repo = initRepo(join(scratch, "repo"));
    const result = inspectWorkspaceId(repo);

    expect(result).toEqual({ status: "missing", path: gitWorkspaceIdPath(repo) });
    if (result.status === "missing") expect(existsSync(result.path)).toBe(false);
  });

  it("returns not_git without writing outside a repository", () => {
    const directory = join(scratch, "plain");
    mkdirSync(directory);

    expect(inspectWorkspaceId(directory)).toEqual({ status: "not_git" });
    expect(getOrCreateWorkspaceId(directory)).toEqual({ status: "not_git" });
    expect(existsSync(join(directory, ".git"))).toBe(false);
  });

  it("does not treat an empty .git directory as a worktree", () => {
    const directory = join(scratch, "not-a-repo");
    mkdirSync(join(directory, ".git"), { recursive: true });

    expect(getOrCreateWorkspaceId(directory)).toEqual({ status: "not_git" });
    expect(existsSync(join(directory, ".git", "prim", "workspace-id"))).toBe(false);
  });

  it("does not create metadata behind a gitfile whose target is missing", () => {
    const directory = join(scratch, "broken-worktree");
    const missingGitDirectory = join(scratch, "missing-gitdir");
    mkdirSync(directory);
    writeFileSync(join(directory, ".git"), `gitdir: ${missingGitDirectory}\n`);

    expect(getOrCreateWorkspaceId(directory)).toEqual({ status: "not_git" });
    expect(existsSync(missingGitDirectory)).toBe(false);
  });

  it("does not adopt an enclosing repository when a nested .git entry is malformed", () => {
    const parent = initRepo(join(scratch, "parent"));
    const parentIdentity = getOrCreateWorkspaceId(parent);
    const nested = join(parent, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, ".git"), "not a gitdir\n");

    const nestedIdentity = getOrCreateWorkspaceId(nested);
    expect(parentIdentity.status).toBe("ready");
    expect(nestedIdentity.status).not.toBe("ready");
    if (parentIdentity.status === "ready") {
      expect(readFileSync(parentIdentity.path, "utf8")).toBe(`${parentIdentity.workspaceId}\n`);
    }
  });

  it("does not rotate a corrupt identity", () => {
    const repo = initRepo(join(scratch, "repo"));
    const path = gitWorkspaceIdPath(repo);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, "not-a-uuid\n", { mode: 0o600 });

    expect(getOrCreateWorkspaceId(repo)).toEqual({
      status: "corrupt",
      path,
      reason: "invalid_content",
    });
    expect(readFileSync(path, "utf8")).toBe("not-a-uuid\n");
  });

  it.runIf(process.platform !== "win32" && process.getuid?.() !== 0)(
    "reports an unreadable identity without replacing it",
    () => {
      const repo = initRepo(join(scratch, "repo"));
      const created = getOrCreateWorkspaceId(repo);
      expect(created.status).toBe("ready");
      if (created.status !== "ready") return;
      chmodSync(created.path, 0o000);

      try {
        const result = getOrCreateWorkspaceId(repo);
        expect(result.status).toBe("unavailable");
        if (result.status === "unavailable") expect(result.operation).toBe("read");
      } finally {
        chmodSync(created.path, 0o600);
      }

      expect(readFileSync(created.path, "utf8")).toBe(`${created.workspaceId}\n`);
    },
  );

  it("reports when the identity directory cannot be created", () => {
    const repo = initRepo(join(scratch, "repo"));
    const parent = dirname(gitWorkspaceIdPath(repo));
    writeFileSync(parent, "blocks the prim directory");

    const result = getOrCreateWorkspaceId(repo);
    expect(result.status).toBe("unavailable");
    if (result.status === "unavailable") expect(result.operation).toBe("create");
  });

  it("assigns distinct identities to the main and linked worktrees", () => {
    const repo = initRepo(join(scratch, "main"));
    commitEmpty(repo);
    const linked = join(scratch, "linked");
    execFileSync("git", ["-C", repo, "worktree", "add", "-q", "-b", "linked", linked]);

    const mainIdentity = getOrCreateWorkspaceId(repo);
    const linkedIdentity = getOrCreateWorkspaceId(linked);
    expect(mainIdentity.status).toBe("ready");
    expect(linkedIdentity.status).toBe("ready");
    if (mainIdentity.status !== "ready" || linkedIdentity.status !== "ready") return;

    expect(linkedIdentity.workspaceId).not.toBe(mainIdentity.workspaceId);
    expect(linkedIdentity.path).toBe(gitWorkspaceIdPath(linked));
    expect(linkedIdentity.path).not.toBe(mainIdentity.path);
  });

  it("gives a clone a new identity", () => {
    const source = initRepo(join(scratch, "source"));
    commitEmpty(source);
    const sourceIdentity = getOrCreateWorkspaceId(source);
    const clone = join(scratch, "clone");
    execFileSync("git", ["clone", "-q", "--no-hardlinks", source, clone]);
    const cloneIdentity = getOrCreateWorkspaceId(clone);

    expect(sourceIdentity.status).toBe("ready");
    expect(cloneIdentity.status).toBe("ready");
    if (sourceIdentity.status !== "ready" || cloneIdentity.status !== "ready") return;
    expect(cloneIdentity.workspaceId).not.toBe(sourceIdentity.workspaceId);
  });

  it("preserves identity when a normal worktree is relocated", () => {
    const original = initRepo(join(scratch, "before"));
    const first = getOrCreateWorkspaceId(original);
    const relocated = join(scratch, "after");
    renameSync(original, relocated);
    mkdirSync(join(relocated, "nested"));
    const second = getOrCreateWorkspaceId(join(relocated, "nested"));

    expect(first.status).toBe("ready");
    expect(second.status).toBe("ready");
    if (first.status !== "ready" || second.status !== "ready") return;
    expect(second.workspaceId).toBe(first.workspaceId);
    expect(second.path).toBe(join(relocated, ".git", "prim", "workspace-id"));
  });

  it("converges across racing processes", async () => {
    const repo = initRepo(join(scratch, "repo"));
    const modulePath = join(scratch, "workspace-id.mjs");
    const sourcePath = new URL("./workspace-id.ts", import.meta.url);
    const transpiled = ts.transpileModule(readFileSync(sourcePath, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
      },
    });
    writeFileSync(modulePath, transpiled.outputText);

    const script = [
      `import { getOrCreateWorkspaceId } from ${JSON.stringify(pathToFileURL(modulePath).href)};`,
      "process.stdout.write(JSON.stringify(getOrCreateWorkspaceId(process.argv[1])));",
    ].join("\n");
    const results = await Promise.all(
      Array.from({ length: 12 }, async () => {
        const { stdout } = await execFileAsync(process.execPath, [
          "--input-type=module",
          "--eval",
          script,
          repo,
        ]);
        return JSON.parse(stdout) as ReturnType<typeof getOrCreateWorkspaceId>;
      }),
    );

    expect(results.every((result) => result.status === "ready")).toBe(true);
    const ids = new Set(
      results.flatMap((result) => (result.status === "ready" ? [result.workspaceId] : [])),
    );
    expect(ids.size).toBe(1);
    expect(results.filter((result) => result.status === "ready" && result.created)).toHaveLength(1);
  });

  it("validates only canonical lowercase UUIDs", () => {
    expect(isCanonicalWorkspaceId(KNOWN_UUID)).toBe(true);
    expect(isCanonicalWorkspaceId(KNOWN_UUID.toUpperCase())).toBe(false);
    expect(isCanonicalWorkspaceId(` ${KNOWN_UUID}`)).toBe(false);
    expect(isCanonicalWorkspaceId("00000000-0000-0000-0000-000000000000")).toBe(false);
  });
});

function initRepo(path: string): string {
  execFileSync("git", ["init", "-q", path]);
  return path;
}

function commitEmpty(repo: string): void {
  execFileSync("git", [
    "-C",
    repo,
    "-c",
    "user.name=Prim Test",
    "-c",
    "user.email=prim@example.invalid",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "-q",
    "--allow-empty",
    "-m",
    "initial",
  ]);
}

function gitWorkspaceIdPath(cwd: string): string {
  const gitPath = execFileSync("git", ["rev-parse", "--git-path", "prim/workspace-id"], {
    cwd,
    encoding: "utf8",
  }).trim();
  return resolve(cwd, gitPath);
}
