import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveOrg } from "../binding.js";
import { appendMove } from "../journal.js";
import { isRepoActiveForCapture } from "../lib/activation.js";
import type { Move } from "../protocol/move.js";
import { runPostCommit } from "./post-commit.js";
import { toCommitMove } from "./prim-hook-core.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
  spawn: vi.fn(),
}));
vi.mock("node:fs", () => ({ readFileSync: vi.fn() }));
vi.mock("../binding.js", () => ({ resolveOrg: vi.fn() }));
vi.mock("../journal.js", () => ({ appendMove: vi.fn() }));
vi.mock("../lib/activation.js", () => ({ isRepoActiveForCapture: vi.fn() }));
vi.mock("./prim-hook-core.js", () => ({ toCommitMove: vi.fn() }));

const mockedExecSync = vi.mocked(execSync);
const mockedSpawn = vi.mocked(spawn);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedResolveOrg = vi.mocked(resolveOrg);
const mockedAppendMove = vi.mocked(appendMove);
const mockedIsRepoActiveForCapture = vi.mocked(isRepoActiveForCapture);
const mockedToCommitMove = vi.mocked(toCommitMove);

const move = {
  moveId: "commit:abc123",
  capturedAt: 1,
  sessionId: "",
  eventType: "git.commit",
  payload: { kind: "git.commit", sha: "abc123", files: ["src/index.ts"] },
  env: { cwd: "/repo", cliVersion: "1.2.3", osPlatform: "darwin" },
  envelopeVersion: 1,
} as Move;

function gitOutput(command: string): string {
  switch (command) {
    case "git rev-parse --show-toplevel":
      return "/repo";
    case "git rev-parse HEAD":
      return "abc123";
    case "git rev-parse --abbrev-ref HEAD":
      return "main";
    case "git diff-tree --no-commit-id --name-only -r -m --root HEAD":
      return "src/index.ts";
    case "git rev-parse --verify --quiet HEAD^":
      return "parent123";
    default:
      throw new Error(`unexpected command: ${command}`);
  }
}

describe("runPostCommit", () => {
  const unref = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockedExecSync.mockImplementation(((command: string) => gitOutput(command)) as typeof execSync);
    mockedReadFileSync.mockReturnValue('{"version":"1.2.3"}');
    mockedResolveOrg.mockReturnValue({ orgId: "org-1", source: "binding" });
    mockedToCommitMove.mockReturnValue(move);
    mockedSpawn.mockReturnValue({ unref } as ReturnType<typeof spawn>);
  });

  it("captures and flushes a commit when its repository is active", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(true);

    runPostCommit();

    expect(mockedIsRepoActiveForCapture).toHaveBeenCalledWith("/repo");
    expect(mockedToCommitMove).toHaveBeenCalledWith(
      {
        sha: "abc123",
        parentSha: "parent123",
        branch: "main",
        files: ["src/index.ts"],
      },
      "1.2.3",
      "/repo",
    );
    expect(mockedResolveOrg).toHaveBeenCalledWith({ sessionId: "", cwd: "/repo" });
    expect(mockedAppendMove).toHaveBeenCalledWith(move, "org-1");
    expect(mockedSpawn).toHaveBeenCalledOnce();
    expect(unref).toHaveBeenCalledOnce();
  });

  it("does no capture work when its repository is inactive", () => {
    mockedIsRepoActiveForCapture.mockReturnValue(false);

    runPostCommit();

    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedExecSync).toHaveBeenCalledWith("git rev-parse --show-toplevel", expect.anything());
    expect(mockedReadFileSync).not.toHaveBeenCalled();
    expect(mockedToCommitMove).not.toHaveBeenCalled();
    expect(mockedResolveOrg).not.toHaveBeenCalled();
    expect(mockedAppendMove).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });

  it("checks the current directory and does no capture work outside Git", () => {
    mockedExecSync.mockImplementationOnce(() => {
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
    expect(mockedExecSync).toHaveBeenCalledTimes(1);
    expect(mockedToCommitMove).not.toHaveBeenCalled();
    expect(mockedResolveOrg).not.toHaveBeenCalled();
    expect(mockedAppendMove).not.toHaveBeenCalled();
    expect(mockedSpawn).not.toHaveBeenCalled();
  });
});
