import { execSync } from "node:child_process";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getGitContext } from "./git.js";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(),
}));

const mockExec = vi.mocked(execSync);

type ExecMap = Record<string, string | (() => string)>;

function setupExec(map: ExecMap, throwsFor: string[] = []) {
  mockExec.mockImplementation((cmd) => {
    const command = String(cmd);
    if (throwsFor.some((t) => command.includes(t))) {
      throw new Error(`mocked failure for: ${command}`);
    }
    for (const [key, value] of Object.entries(map)) {
      if (command.includes(key)) {
        return typeof value === "function" ? value() : value;
      }
    }
    throw new Error(`unmocked command: ${command}`);
  });
}

describe("getGitContext", () => {
  beforeEach(() => {
    mockExec.mockReset();
  });

  it("parses HTTPS origin into owner/repo", () => {
    setupExec({
      "rev-parse --abbrev-ref HEAD": "main\n",
      "rev-parse HEAD": "abc123\n",
      "remote get-url origin": "https://github.com/campus-ai/prim\n",
      "command -v gh": "/usr/bin/gh\n",
      "gh pr view": "42\n",
    });

    expect(getGitContext()).toEqual({
      branch: "main",
      sha: "abc123",
      repoFullName: "campus-ai/prim",
      prNumber: 42,
    });
  });

  it("strips .git suffix from HTTPS origin", () => {
    setupExec({
      "rev-parse --abbrev-ref HEAD": "main",
      "rev-parse HEAD": "abc123",
      "remote get-url origin": "https://github.com/campus-ai/prim.git",
      "command -v gh": "",
    });

    expect(getGitContext().repoFullName).toBe("campus-ai/prim");
  });

  it("parses SSH origin into owner/repo", () => {
    setupExec({
      "rev-parse --abbrev-ref HEAD": "main",
      "rev-parse HEAD": "abc123",
      "remote get-url origin": "git@github.com:campus-ai/prim.git",
      "command -v gh": "",
    });

    expect(getGitContext().repoFullName).toBe("campus-ai/prim");
  });

  it("returns null branch on detached HEAD", () => {
    setupExec({
      "rev-parse --abbrev-ref HEAD": "HEAD",
      "rev-parse HEAD": "abc123",
      "remote get-url origin": "https://github.com/campus-ai/prim",
      "command -v gh": "",
    });

    expect(getGitContext().branch).toBeNull();
  });

  it("leaves other fields independent when origin remote is missing", () => {
    setupExec(
      {
        "rev-parse --abbrev-ref HEAD": "main",
        "rev-parse HEAD": "abc123",
        "command -v gh": "",
      },
      ["remote get-url origin"],
    );

    expect(getGitContext()).toEqual({
      branch: "main",
      sha: "abc123",
      repoFullName: null,
      prNumber: null,
    });
  });

  it("returns null repoFullName for non-GitHub remotes", () => {
    setupExec({
      "rev-parse --abbrev-ref HEAD": "main",
      "rev-parse HEAD": "abc123",
      "remote get-url origin": "git@gitlab.com:foo/bar.git",
      "command -v gh": "",
    });

    expect(getGitContext().repoFullName).toBeNull();
  });

  it("returns null prNumber when gh is not on the PATH", () => {
    setupExec(
      {
        "rev-parse --abbrev-ref HEAD": "main",
        "rev-parse HEAD": "abc123",
        "remote get-url origin": "https://github.com/campus-ai/prim",
      },
      ["command -v gh"],
    );

    expect(getGitContext().prNumber).toBeNull();
  });

  it("returns null prNumber when gh is present but no PR exists", () => {
    setupExec(
      {
        "rev-parse --abbrev-ref HEAD": "main",
        "rev-parse HEAD": "abc123",
        "remote get-url origin": "https://github.com/campus-ai/prim",
        "command -v gh": "/usr/bin/gh",
      },
      ["gh pr view"],
    );

    expect(getGitContext().prNumber).toBeNull();
  });
});
