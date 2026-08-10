import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  truncateSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveOrg } from "../binding.js";
import { appendMove } from "../journal.js";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { githubRepositoryFullName, resolveRepositoryContext } from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Move } from "../protocol/move.js";
import { parseRewritePairs, rewritePairsFromLauncher, runPostRewrite } from "./post-rewrite.js";
import { toRewriteMove } from "./prim-hook-core.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("../binding.js", () => ({ resolveOrg: vi.fn() }));
vi.mock("../journal.js", () => ({ appendMove: vi.fn() }));
vi.mock("../lib/activation.js", () => ({
  isRepoActiveForCapture: vi.fn(),
  repoSyncId: vi.fn(),
}));
vi.mock("../lib/git.js", () => ({
  githubRepositoryFullName: vi.fn(),
  resolveRepositoryContext: vi.fn(),
}));
vi.mock("../lib/workspace-id.js", () => ({ getOrCreateWorkspaceId: vi.fn() }));
vi.mock("./prim-hook-core.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./prim-hook-core.js")>();
  return { ...actual, toRewriteMove: vi.fn() };
});

const oldA = "a".repeat(40);
const oldB = "b".repeat(40);
const newA = "c".repeat(40);
const newB = "d".repeat(40);
const now = 1_785_000_000_000;
const temporaryDirectories: string[] = [];

function privatePairsFile(content = `${oldA} ${newA}\n`): string {
  const directory = mkdtempSync(join(tmpdir(), "prim-post-rewrite-test-"));
  temporaryDirectories.push(directory);
  const path = join(directory, "prim-post-rewrite-pairs.ABC123");
  writeFileSync(path, content, { mode: 0o600 });
  const observed = new Date(now);
  utimesSync(path, observed, observed);
  return path;
}

const move = (id: string): Move => ({
  moveId: id,
  capturedAt: now,
  sessionId: "",
  eventType: "git.rewrite",
  payload: { kind: "git.rewrite" },
  env: { cwd: "/repo", cliVersion: "1.0.0", osPlatform: process.platform },
  envelopeVersion: 1,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.setSystemTime(now);
  vi.mocked(execFileSync).mockReturnValue("/repo\n");
  vi.mocked(spawn).mockReturnValue({ unref: vi.fn() } as unknown as ReturnType<typeof spawn>);
  vi.mocked(isRepoActiveForCapture).mockReturnValue(true);
  vi.mocked(repoSyncId).mockReturnValue("repoSync123");
  vi.mocked(resolveRepositoryContext).mockReturnValue({
    repoRoot: "/repo",
    repoKey: "repo_v1_key",
  });
  vi.mocked(githubRepositoryFullName).mockReturnValue("campus-ai/primitive");
  vi.mocked(getOrCreateWorkspaceId).mockReturnValue({
    status: "ready",
    workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
    path: "/repo/.git/prim/workspace-id",
    created: false,
  });
  vi.mocked(resolveOrg).mockReturnValue({ orgId: "org123", source: "workspace" });
  vi.mocked(toRewriteMove).mockReturnValue([move("rewrite-1")]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("parseRewritePairs", () => {
  it("normalizes, de-duplicates, sorts, drops self-pairs, and permits one extra token", () => {
    expect(
      parseRewritePairs(
        `${oldB.toUpperCase()} ${newB.toUpperCase()} metadata\n${oldA} ${newA}\n${oldA} ${newA}\n${newA} ${newA}\n`,
      ),
    ).toEqual([
      { oldSha: oldA, newSha: newA },
      { oldSha: oldB, newSha: newB },
    ]);
  });

  it.each([
    `${oldA.slice(1)} ${newA}\n`,
    `${oldA} ${newA} two tokens\n`,
    `${oldA}  ${newA}\n`,
    ` ${oldA} ${newA}\n`,
    `${oldA} ${newA}\r\n`,
    `${oldA} ${newA}\n\n`,
    `${"g".repeat(40)} ${newA}\n`,
  ])("rejects the whole invocation when any line is malformed", (content) => {
    expect(parseRewritePairs(`${oldB} ${newB}\n${content}`)).toBeUndefined();
  });

  it("truncates after canonical sorting so input order cannot change the result", () => {
    const pairs = Array.from({ length: 2_005 }, (_, index) => {
      const oldSha = index.toString(16).padStart(40, "0");
      const newSha = (index + 10_000).toString(16).padStart(40, "0");
      return `${oldSha} ${newSha}`;
    });
    const forward = parseRewritePairs(`${pairs.join("\n")}\n`);
    const reverse = parseRewritePairs(`${[...pairs].reverse().join("\n")}\n`);
    expect(forward).toHaveLength(2_000);
    expect(reverse).toEqual(forward);
  });
});

describe("rewritePairsFromLauncher", () => {
  it("accepts a fresh, owned, regular 0600 file with the pinned basename", () => {
    const path = privatePairsFile();
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: path }, now)).toMatchObject({
      path,
      capturedAt: now,
      pairs: [{ oldSha: oldA, newSha: newA }],
    });
  });

  it("rejects relative and unexpected paths", () => {
    expect(
      rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: "prim-post-rewrite-pairs.ABC" }, now),
    ).toBeUndefined();
    const directory = mkdtempSync(join(tmpdir(), "prim-post-rewrite-test-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "different.ABC");
    writeFileSync(path, `${oldA} ${newA}\n`, { mode: 0o600 });
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: path }, now)).toBeUndefined();
  });

  it("rejects symlinks, directories, multiple links, and non-0600 modes", () => {
    const target = privatePairsFile();
    const directory = join(target, "..");
    const symlink = join(directory, "prim-post-rewrite-pairs.SYMLINK");
    symlinkSync(target, symlink);
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: symlink }, now)).toBeUndefined();

    const dirPath = join(directory, "prim-post-rewrite-pairs.DIRECTORY");
    mkdirSync(dirPath);
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: dirPath }, now)).toBeUndefined();

    const hardLink = join(directory, "prim-post-rewrite-pairs.HARDLINK");
    linkSync(target, hardLink);
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: target }, now)).toBeUndefined();

    const wrongMode = privatePairsFile();
    chmodSync(wrongMode, 0o640);
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: wrongMode }, now)).toBeUndefined();
  });

  it("rejects oversized, stale, and future-dated files", () => {
    const oversized = privatePairsFile();
    truncateSync(oversized, 1_048_577);
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: oversized }, now)).toBeUndefined();

    const stale = privatePairsFile();
    const staleAt = new Date(now - 10 * 60 * 1_000 - 1);
    utimesSync(stale, staleAt, staleAt);
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: stale }, now)).toBeUndefined();

    const future = privatePairsFile();
    const futureAt = new Date(now + 6_000);
    utimesSync(future, futureAt, futureAt);
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: future }, now)).toBeUndefined();
  });

  it("rejects invalid UTF-8 and malformed pair contents", () => {
    const invalidUtf8 = privatePairsFile();
    writeFileSync(invalidUtf8, Buffer.from([0xff]), { mode: 0o600 });
    const observed = new Date(now);
    utimesSync(invalidUtf8, observed, observed);
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: invalidUtf8 }, now)).toBeUndefined();

    const malformed = privatePairsFile("not a pair\n");
    expect(rewritePairsFromLauncher({ PRIM_REWRITE_PAIRS_FILE: malformed }, now)).toBeUndefined();
  });
});

describe("runPostRewrite", () => {
  function launcherEnv(path: string, source: "amend" | "rebase" = "rebase"): void {
    vi.stubEnv("PRIM_REWRITE_PAIRS_FILE", path);
    vi.stubEnv("PRIM_REWRITE_SOURCE", source);
    vi.stubEnv("PRIM_REWRITE_BRANCH", "feature");
  }

  it("emits every deterministic chunk, flushes once, and removes the private file", () => {
    const path = privatePairsFile(`${oldB} ${newB}\n${oldA} ${newA}\n`);
    launcherEnv(path);
    vi.mocked(toRewriteMove).mockReturnValue([move("rewrite-1"), move("rewrite-2")]);

    runPostRewrite();

    expect(toRewriteMove).toHaveBeenCalledWith(
      {
        source: "rebase",
        branch: "feature",
        pairs: [
          { oldSha: oldA, newSha: newA },
          { oldSha: oldB, newSha: newB },
        ],
      },
      expect.any(String),
      "/repo",
      expect.objectContaining({
        repoFullName: "campus-ai/primitive",
        repoSyncId: "repoSync123",
        workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
        capturedAt: now,
      }),
    );
    expect(appendMove).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ moveId: "rewrite-1" }),
      "org123",
    );
    expect(appendMove).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ moveId: "rewrite-2" }),
      "org123",
    );
    expect(spawn).toHaveBeenCalledOnce();
    expect(existsSync(path)).toBe(false);
  });

  it("is inactive-repo fail-soft while still cleaning up the launcher file", () => {
    const path = privatePairsFile();
    launcherEnv(path, "amend");
    vi.mocked(isRepoActiveForCapture).mockReturnValue(false);

    runPostRewrite();

    expect(toRewriteMove).not.toHaveBeenCalled();
    expect(appendMove).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });

  it("rejects an unknown source and cleans up without capture", () => {
    const path = privatePairsFile();
    launcherEnv(path);
    vi.stubEnv("PRIM_REWRITE_SOURCE", "filter-branch");

    runPostRewrite();

    expect(toRewriteMove).not.toHaveBeenCalled();
    expect(appendMove).not.toHaveBeenCalled();
    expect(existsSync(path)).toBe(false);
  });
});
