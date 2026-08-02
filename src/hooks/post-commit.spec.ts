import { execFileSync, spawn } from "node:child_process";
import { lstatSync, readFileSync } from "node:fs";
import { resolveOrg } from "../binding.js";
import { appendMove } from "../journal.js";
import { isRepoActiveForCapture, repoSyncId } from "../lib/activation.js";
import { githubRepositoryFullName, resolveRepositoryContext } from "../lib/git.js";
import { getOrCreateWorkspaceId } from "../lib/workspace-id.js";
import type { Move } from "../protocol/move.js";
import { capturedAtFromLauncher, runPostCommit } from "./post-commit.js";
import { commitAttributionFromEnvironment, toCommitMove } from "./prim-hook-core.js";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:fs", () => ({ lstatSync: vi.fn(), readFileSync: vi.fn() }));
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
vi.mock("./prim-hook-core.js", () => ({
  commitAttributionFromEnvironment: vi.fn(),
  toCommitMove: vi.fn(),
}));

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedSpawn = vi.mocked(spawn);
const mockedLstatSync = vi.mocked(lstatSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedResolveOrg = vi.mocked(resolveOrg);
const mockedAppendMove = vi.mocked(appendMove);
const mockedIsRepoActiveForCapture = vi.mocked(isRepoActiveForCapture);
const mockedRepoSyncId = vi.mocked(repoSyncId);
const mockedGithubRepositoryFullName = vi.mocked(githubRepositoryFullName);
const mockedResolveRepositoryContext = vi.mocked(resolveRepositoryContext);
const mockedGetOrCreateWorkspaceId = vi.mocked(getOrCreateWorkspaceId);
const mockedCommitAttributionFromEnvironment = vi.mocked(commitAttributionFromEnvironment);
const mockedToCommitMove = vi.mocked(toCommitMove);

const SHA = "a".repeat(40);
const PARENT_SHA = "b".repeat(40);
const move = {
  moveId: `commit:v2:${"c".repeat(64)}`,
  capturedAt: 1,
  sessionId: "",
  eventType: "git.commit",
  payload: {
    kind: "git.commit",
    sha: SHA,
    changedFiles: ["src/index.ts"],
    changedFilesComplete: true,
  },
  env: { cwd: "/repo", cliVersion: "1.2.3", osPlatform: "darwin" },
  envelopeVersion: 1,
} as Move;

function launcherMarkerStat(
  overrides: Partial<{
    isFile: () => boolean;
    isSymbolicLink: () => boolean;
    size: number;
    nlink: number;
    mode: number;
    uid: number;
    mtimeMs: number;
  }> = {},
): ReturnType<typeof lstatSync> {
  return {
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 0,
    nlink: 1,
    mode: 0o100600,
    uid: process.getuid?.() ?? 501,
    mtimeMs: 1_785_000_000_123.75,
    ...overrides,
  } as ReturnType<typeof lstatSync>;
}

function gitOutput(args: readonly string[]): string | Buffer {
  switch (args.join(" ")) {
    case "rev-parse --show-toplevel":
      return "/repo";
    case "rev-parse HEAD":
      return SHA;
    case "rev-parse --abbrev-ref HEAD":
      return "main";
    case `diff-tree --no-commit-id --name-only -z -r -m --root ${SHA}`:
      return Buffer.from("src/index.ts\0");
    case `rev-parse --verify --quiet ${SHA}^`:
      return PARENT_SHA;
    default:
      throw new Error(`unexpected command: ${args.join(" ")}`);
  }
}

describe("runPostCommit", () => {
  const unref = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecFileSync.mockImplementation(((_git: string, args: string[]) =>
      gitOutput(args)) as typeof execFileSync);
    mockedReadFileSync.mockReturnValue('{"version":"1.2.3"}');
    mockedResolveOrg.mockReturnValue({ orgId: "org-1", source: "binding" });
    mockedResolveRepositoryContext.mockReturnValue({
      repoRoot: "/repo",
      repoKey: "repo_v1_key",
    });
    mockedGithubRepositoryFullName.mockReturnValue("campus-ai/primitive");
    mockedRepoSyncId.mockReturnValue("repoSync123");
    mockedGetOrCreateWorkspaceId.mockReturnValue({
      status: "ready",
      workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
      path: "/repo/.git/prim/workspace-id",
      created: false,
    });
    mockedCommitAttributionFromEnvironment.mockReturnValue(undefined);
    mockedToCommitMove.mockReturnValue(move);
    mockedSpawn.mockReturnValue({ unref } as ReturnType<typeof spawn>);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("captures and flushes a commit when its repository is active", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(true);

    runPostCommit();

    expect(mockedIsRepoActiveForCapture).toHaveBeenCalledWith("/repo");
    expect(mockedToCommitMove).toHaveBeenCalledWith(
      {
        sha: SHA,
        parentSha: PARENT_SHA,
        branch: "main",
        files: ["src/index.ts"],
        filesComplete: true,
      },
      "1.2.3",
      "/repo",
      {
        repository: { repoRoot: "/repo", repoKey: "repo_v1_key" },
        repoFullName: "campus-ai/primitive",
        repoSyncId: "repoSync123",
        workspaceId: "d84b97dc-b69f-4b59-9d0a-f6b3436239a4",
        attribution: undefined,
      },
    );
    expect(mockedResolveOrg).toHaveBeenCalledWith({ sessionId: "", cwd: "/repo" });
    expect(mockedAppendMove).toHaveBeenCalledWith(move, "org-1");
    expect(mockedSpawn).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
    for (const call of mockedExecFileSync.mock.calls) {
      expect(call[2]).toEqual(expect.objectContaining({ timeout: 1_000 }));
    }
  });

  it("passes a strictly validated synchronous launcher timestamp to the move", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(true);
    vi.stubEnv("PRIM_COMMIT_OBSERVED_FILE", "/tmp/prim-post-commit-observed.ABC123");
    mockedLstatSync.mockReturnValue(launcherMarkerStat());
    const now = vi.spyOn(Date, "now").mockReturnValue(1_785_000_000_456);

    try {
      runPostCommit();
    } finally {
      now.mockRestore();
    }

    expect(mockedToCommitMove).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ capturedAt: 1_785_000_000_123 }),
    );
  });

  it("fails closed when a launcher marker was supplied but is invalid", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(true);
    vi.stubEnv("PRIM_COMMIT_OBSERVED_FILE", "/tmp/prim-post-commit-observed.ABC123");
    mockedLstatSync.mockReturnValue(launcherMarkerStat({ size: 1 }));

    runPostCommit();

    expect(mockedToCommitMove).not.toHaveBeenCalled();
    expect(mockedResolveOrg).not.toHaveBeenCalled();
    expect(mockedAppendMove).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("does no capture work when its repository is inactive", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(false);

    runPostCommit();

    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--show-toplevel"],
      expect.anything(),
    );
    expect(mockedReadFileSync).not.toHaveBeenCalled();
    expect(mockedToCommitMove).not.toHaveBeenCalled();
    expect(mockedResolveOrg).not.toHaveBeenCalled();
    expect(mockedAppendMove).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("checks the current directory and does no capture work outside Git", () => {
    mockedExecFileSync.mockImplementationOnce(() => {
      throw new Error("not a Git repository");
    });
    mockedIsRepoActiveForCapture.mockReturnValue(false);
    const cwd = vi.spyOn(process, "cwd").mockReturnValue("/outside-git");

    try {
      runPostCommit();
    } finally {
      cwd.mockRestore();
    }

    expect(mockedIsRepoActiveForCapture).toHaveBeenCalledWith("/outside-git");
    expect(mockedExecFileSync).toHaveBeenCalledTimes(1);
    expect(mockedToCommitMove).not.toHaveBeenCalled();
    expect(mockedResolveOrg).not.toHaveBeenCalled();
    expect(mockedAppendMove).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("preserves newline-containing filenames through NUL-delimited Git output", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(true);
    mockedExecFileSync.mockImplementation(((_git: string, args: string[]) =>
      args[0] === "diff-tree"
        ? Buffer.from("src/line\nbreak.ts\0")
        : gitOutput(args)) as typeof execFileSync);

    runPostCommit();

    expect(mockedToCommitMove).toHaveBeenCalledWith(
      expect.objectContaining({
        files: ["src/line\nbreak.ts"],
        filesComplete: true,
      }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("marks changed files incomplete when diff-tree fails", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(true);
    mockedExecFileSync.mockImplementation(((_git: string, args: string[]) => {
      if (args[0] === "diff-tree") throw new Error("diff failed");
      return gitOutput(args);
    }) as typeof execFileSync);

    runPostCommit();

    expect(mockedToCommitMove).toHaveBeenCalledWith(
      expect.objectContaining({ files: [], filesComplete: false }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("distinguishes a valid empty commit from incomplete file enumeration", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(true);
    mockedExecFileSync.mockImplementation(((_git: string, args: string[]) =>
      args[0] === "diff-tree" ? Buffer.alloc(0) : gitOutput(args)) as typeof execFileSync);

    runPostCommit();

    expect(mockedToCommitMove).toHaveBeenCalledWith(
      expect.objectContaining({ files: [], filesComplete: true }),
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it("uses immutable launcher snapshots across rapid sequential commits", () => {
    const secondSha = "c".repeat(40);
    mockedIsRepoActiveForCapture.mockReturnValue(true);
    mockedExecFileSync.mockImplementation(((_git: string, args: string[]) => {
      const joined = args.join(" ");
      if (joined === "rev-parse --show-toplevel") return "/repo";
      if (args[0] === "diff-tree") {
        return Buffer.from(args.at(-1) === SHA ? "first.ts\0" : "second.ts\0");
      }
      if (joined === `rev-parse --verify --quiet ${SHA}^`) return PARENT_SHA;
      if (joined === `rev-parse --verify --quiet ${secondSha}^`) return SHA;
      throw new Error(`unexpected command: ${joined}`);
    }) as typeof execFileSync);
    mockedToCommitMove.mockImplementation(
      (commit) =>
        ({
          ...move,
          moveId: `captured:${commit.sha}`,
          payload: {
            ...move.payload,
            sha: commit.sha,
            changedFiles: commit.files,
          },
        }) as Move,
    );

    vi.stubEnv("PRIM_COMMIT_SHA", SHA);
    vi.stubEnv("PRIM_COMMIT_BRANCH", "main");
    runPostCommit();
    vi.stubEnv("PRIM_COMMIT_SHA", secondSha);
    runPostCommit();

    expect(mockedToCommitMove.mock.calls.map(([commit]) => commit)).toEqual([
      expect.objectContaining({ sha: SHA, files: ["first.ts"], branch: "main" }),
      expect.objectContaining({ sha: secondSha, files: ["second.ts"], branch: "main" }),
    ]);
    expect(mockedAppendMove.mock.calls.map(([captured]) => captured.moveId)).toEqual([
      `captured:${SHA}`,
      `captured:${secondSha}`,
    ]);
    expect(
      mockedExecFileSync.mock.calls.some(
        ([, args]) => (args as string[]).join(" ") === "rev-parse HEAD",
      ),
    ).toBe(false);
  });
});

describe("capturedAtFromLauncher", () => {
  const now = 1_785_000_000_456;
  const path = "/tmp/prim-post-commit-observed.ABC123";

  beforeEach(() => {
    vi.clearAllMocks();
    mockedLstatSync.mockReturnValue(launcherMarkerStat());
  });

  it("accepts only a private, fresh, owned empty marker", () => {
    expect(capturedAtFromLauncher({ PRIM_COMMIT_OBSERVED_FILE: path }, now)).toBe(
      1_785_000_000_123,
    );
  });

  it.each([
    ["relative path", "prim-post-commit-observed.ABC123", undefined],
    ["unexpected basename", "/tmp/other.ABC123", undefined],
    ["symlink", path, { isSymbolicLink: () => true }],
    ["non-file", path, { isFile: () => false }],
    ["nonempty file", path, { size: 1 }],
    ["multiple links", path, { nlink: 2 }],
    ["group-readable", path, { mode: 0o100640 }],
    ["wrong owner", path, { uid: (process.getuid?.() ?? 501) + 1 }],
    ["stale marker", path, { mtimeMs: now - 10 * 60 * 1_000 - 1 }],
    ["future marker", path, { mtimeMs: now + 5_001 }],
  ])("rejects a %s", (_label, markerPath, overrides) => {
    if (overrides) mockedLstatSync.mockReturnValue(launcherMarkerStat(overrides));
    expect(capturedAtFromLauncher({ PRIM_COMMIT_OBSERVED_FILE: markerPath }, now)).toBeUndefined();
  });
});
