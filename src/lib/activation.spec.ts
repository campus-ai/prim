import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
}));

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import {
  PRIM_ACTIVE_KEY,
  PRIM_REPO_SYNC_ID_KEY,
  decisionIngestionStatus,
  hasProjectPrimInstall,
  isRepoActive,
  isRepoActiveForCapture,
  isValidRepoSyncId,
  repoActiveFlag,
  repoSyncId,
  setRepoActive,
  setRepoSyncId,
} from "./activation.js";

const mockedExecFileSync = vi.mocked(execFileSync);
const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);

// Type-safe enough for tests: execFileSync's overloads make a direct
// mockReturnValue awkward, so drive it through mockImplementation.
const stubGit = (impl: () => string): void => {
  mockedExecFileSync.mockImplementation(impl as unknown as typeof execFileSync);
};

// Drive `git config --get prim.active` and `git rev-parse --show-toplevel`
// independently: flag/root === undefined → the command throws (unset / not a repo).
const gitMock = (opts: { flag?: string; root?: string }): void => {
  mockedExecFileSync.mockImplementation(((_c: string, args: string[]): string => {
    if (args[0] === "config") {
      if (opts.flag === undefined) throw new Error("unset");
      return `${opts.flag}\n`;
    }
    if (args[0] === "rev-parse") {
      if (opts.root === undefined) throw new Error("not a git repository");
      return `${opts.root}\n`;
    }
    return "";
  }) as unknown as typeof execFileSync);
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("isRepoActive", () => {
  it("is true when git resolves prim.active to 'true' (local over global, merged --get)", () => {
    stubGit(() => "true\n");
    expect(isRepoActive("/repo")).toBe(true);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--get", PRIM_ACTIVE_KEY],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("is false for any other value", () => {
    stubGit(() => "false\n");
    expect(isRepoActive("/repo")).toBe(false);
  });

  it("is false (opt-in default) when the flag is unset — git exits nonzero", () => {
    stubGit(() => {
      throw new Error("exit 1");
    });
    expect(isRepoActive("/repo")).toBe(false);
  });
});

describe("repoActiveFlag", () => {
  it("exposes unset separately for SessionStart legacy activation repair", () => {
    stubGit(() => {
      throw new Error("unset");
    });
    expect(repoActiveFlag("/repo")).toBeUndefined();
  });
});

describe("repository binding", () => {
  it.each(["repoSync123", "sync-1", "A", "a".repeat(64)])(
    "accepts a canonical id (%s)",
    (value) => {
      expect(isValidRepoSyncId(value)).toBe(true);
    },
  );

  it.each(["", "-leading", "with space", "a".repeat(65), "bad\nid"])(
    "rejects a malformed id (%s)",
    (value) => {
      expect(isValidRepoSyncId(value)).toBe(false);
      expect(() => setRepoSyncId("/repo", value)).toThrow(/invalid repository binding/);
    },
  );

  it("filters malformed local config values", () => {
    stubGit(() => "with space\n");
    expect(repoSyncId("/repo")).toBeUndefined();
  });

  it("persists a valid local binding", () => {
    setRepoSyncId("/repo", "repoSync123");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "prim.repoSyncId", "repoSync123"],
      expect.objectContaining({ cwd: "/repo", timeout: 1_000 }),
    );
  });
});

describe("setRepoActive", () => {
  it("writes the repo-local flag true", () => {
    setRepoActive("/repo", true);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", PRIM_ACTIVE_KEY, "true"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("writes the repo-local flag false", () => {
    setRepoActive("/repo", false);
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", PRIM_ACTIVE_KEY, "false"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });
});

describe("repository binding", () => {
  it("reads the worktree-local opaque id", () => {
    stubGit(() => "sync-1\n");
    expect(repoSyncId("/repo")).toBe("sync-1");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", "--get", PRIM_REPO_SYNC_ID_KEY],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("validates before persisting the id", () => {
    expect(() => setRepoSyncId("/repo", "sync-1")).not.toThrow();
    expect(() => setRepoSyncId("/repo", "bad\nid")).toThrow(/invalid repository binding/);
  });
});

describe("hasProjectPrimInstall (self-heal, bounded to the repo root)", () => {
  it("is true when the repo-root .claude/settings.json registers a prim hook", () => {
    gitMock({ root: "/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/repo/.claude/settings.json");
    mockedReadFileSync.mockReturnValue('{"hooks":{"PreToolUse":"prim-pre-tool-use"}}');
    expect(hasProjectPrimInstall("/repo/pkg/src")).toBe(true); // checks the ROOT, from a subdir
  });

  it("is true for a repo-root .codex/hooks.json with a prim bin", () => {
    gitMock({ root: "/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/repo/.codex/hooks.json");
    mockedReadFileSync.mockReturnValue('{"hooks":{"PostToolUse":"prim-hook --agent codex"}}');
    expect(hasProjectPrimInstall("/repo")).toBe(true);
  });

  it("is false when the repo-root config exists but has no prim entry", () => {
    gitMock({ root: "/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/repo/.claude/settings.json");
    mockedReadFileSync.mockReturnValue('{"hooks":{"PreToolUse":"eslint"}}');
    expect(hasProjectPrimInstall("/repo")).toBe(false);
  });

  it("is false outside a git repo (rev-parse fails)", () => {
    gitMock({ root: undefined });
    mockedExistsSync.mockReturnValue(true); // even if some config exists, no repo → no back-fill
    expect(hasProjectPrimInstall("/tmp/x")).toBe(false);
  });

  it("does NOT escape the repo: a prim config only at an ANCESTOR (~/.claude) is ignored", () => {
    // The regression that broke round 1: an unbounded walk reached the
    // user-scope ~/.claude/settings.json and marked every repo under $HOME active.
    gitMock({ root: "/home/jth/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/home/jth/.claude/settings.json");
    mockedReadFileSync.mockReturnValue("prim-hook");
    expect(hasProjectPrimInstall("/home/jth/repo/src")).toBe(false); // only /home/jth/repo/.claude is checked
  });

  it("is false when the repo root IS $HOME (dotfiles-as-repo) — that file is the user-scope config", () => {
    gitMock({ root: homedir() });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("prim-hook");
    expect(hasProjectPrimInstall(homedir())).toBe(false); // never treat ~/.claude as a project install
  });

  it("does not false-positive on unrelated 'prim-' text — matches exact hook bin names only", () => {
    gitMock({ root: "/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/repo/.claude/settings.json");
    mockedReadFileSync.mockReturnValue('{"note":"prim-directive, unrelated to hooks"}');
    expect(hasProjectPrimInstall("/repo")).toBe(false);
  });
});

describe("isRepoActiveForCapture (the agent-hook gate)", () => {
  it("is true when the flag is 'true', without consulting the filesystem", () => {
    gitMock({ flag: "true", root: "/repo" });
    expect(isRepoActiveForCapture("/repo")).toBe(true);
    expect(mockedExistsSync).not.toHaveBeenCalled(); // short-circuits on the flag
  });

  it("is FALSE when the flag is explicitly 'false', even with a project install (prim disable wins)", () => {
    gitMock({ flag: "false", root: "/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/repo/.claude/settings.json");
    mockedReadFileSync.mockReturnValue("prim-hook");
    expect(isRepoActiveForCapture("/repo")).toBe(false); // disable is authoritative
  });

  it("is true via project-install back-fill when the flag is unset (upgrade self-heal)", () => {
    gitMock({ flag: undefined, root: "/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/repo/.claude/settings.json");
    mockedReadFileSync.mockReturnValue("prim-hook");
    expect(isRepoActiveForCapture("/repo")).toBe(true);
  });

  it("is false when unset and no repo-root project install exists (opt-in default)", () => {
    gitMock({ flag: undefined, root: "/repo" });
    mockedExistsSync.mockReturnValue(false);
    expect(isRepoActiveForCapture("/repo")).toBe(false);
  });

  it("is false when unset and only a user-scope ~/.claude config exists (no home-level activation)", () => {
    gitMock({ flag: undefined, root: "/home/jth/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/home/jth/.claude/settings.json");
    mockedReadFileSync.mockReturnValue("prim-hook");
    expect(isRepoActiveForCapture("/home/jth/repo")).toBe(false);
  });
});

describe("decisionIngestionStatus", () => {
  it("is enabled when the local flag is explicitly true", () => {
    gitMock({ flag: "true", root: "/repo" });
    expect(decisionIngestionStatus("/repo")).toBe("enabled");
  });

  it("remains enabled when merged Git config resolves a global prim.active=true", () => {
    gitMock({ flag: "true", root: "/repo" });
    expect(decisionIngestionStatus("/repo")).toBe("enabled");
  });

  it("is disabled when the local flag is explicitly false", () => {
    gitMock({ flag: "false", root: "/repo" });
    expect(decisionIngestionStatus("/repo")).toBe("disabled");
  });

  it("is enabled by a project-install back-fill when the flag is unset", () => {
    gitMock({ flag: undefined, root: "/repo" });
    mockedExistsSync.mockImplementation((p) => String(p) === "/repo/.codex/hooks.json");
    mockedReadFileSync.mockReturnValue("prim-hook");
    expect(decisionIngestionStatus("/repo")).toBe("enabled");
  });

  it("is disabled by default when a repo has no flag or project install", () => {
    gitMock({ flag: undefined, root: "/repo" });
    mockedExistsSync.mockReturnValue(false);
    expect(decisionIngestionStatus("/repo")).toBe("disabled");
  });

  it("is disabled outside Git", () => {
    gitMock({ flag: undefined, root: undefined });
    expect(decisionIngestionStatus("/tmp")).toBe("disabled");
  });
});
