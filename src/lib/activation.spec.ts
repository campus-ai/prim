import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execFileSync: vi.fn(() => ""),
}));

import { execFileSync } from "node:child_process";
import {
  PRIM_ACTIVE_KEY,
  activateRepoBestEffort,
  isRepoActive,
  setRepoActive,
} from "./activation.js";

const mockedExecFileSync = vi.mocked(execFileSync);

// Type-safe enough for tests: execFileSync's overloads make a direct
// mockReturnValue awkward, so drive it through mockImplementation.
const stubGit = (impl: () => string): void => {
  mockedExecFileSync.mockImplementation(impl as unknown as typeof execFileSync);
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

describe("activateRepoBestEffort", () => {
  it("sets the flag true (a project install doubles as `prim enable`)", () => {
    activateRepoBestEffort("/repo");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--local", PRIM_ACTIVE_KEY, "true"],
      expect.objectContaining({ cwd: "/repo" }),
    );
  });

  it("never throws when git fails (non-repo / git missing) — the install already succeeded", () => {
    stubGit(() => {
      throw new Error("not a git repository");
    });
    expect(() => activateRepoBestEffort("/tmp")).not.toThrow();
  });
});
