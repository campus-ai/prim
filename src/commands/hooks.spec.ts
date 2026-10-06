import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "/fake/root"),
  // `git rev-parse --show-toplevel` (via gitToplevel) → the repo root; every
  // `git config --get` reads empty (unset). Reset restores this between tests,
  // so an "unset global + unset system" case needs no per-test setup.
  execFileSync: vi.fn((_cmd, args) => {
    if (!Array.isArray(args) || args[0] !== "rev-parse") return "";
    if (args.includes("--git-path")) return ".git/hooks\n";
    if (args.includes("--git-common-dir")) return ".git\n";
    return "/fake/root\n";
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  readdirSync: vi.fn(() => []),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
  chmodSync: vi.fn(),
  lstatSync: vi.fn(() => ({
    isDirectory: () => true,
    isFile: () => true,
    isSymbolicLink: () => false,
    size: 100,
    mode: 0o100755,
  })),
}));

vi.mock("../lib/git-hooks.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/git-hooks.js")>();
  const ensured = (hookName: string, path: string) => ({
    hookName,
    path,
    changed: true,
    kind: "direct",
    outcome: "created",
  });
  return {
    ...actual,
    ensureEffectiveGitHook: vi.fn((hookName: string, root: string) =>
      ensured(hookName, `${root}/.git/hooks/${hookName}`),
    ),
    ensureGitHookAtPath: vi.fn((hookName: string, path: string) => ensured(hookName, path)),
    gitHooksMode: vi.fn(() => "auto"),
    hasCurrentHookBlock: vi.fn(() => false),
    projectGitHookTarget: vi.fn((hookName: string, root: string) => ({
      gitRoot: root,
      hooksDir: `${root}/.git/hooks`,
      hookPath: `${root}/.git/hooks/${hookName}`,
      kind: "direct",
      location: "repository",
    })),
    resolveEffectiveGitHook: vi.fn((hookName: string, root: string) => ({
      gitRoot: root,
      hooksDir: `${root}/.git/hooks`,
      hookPath: `${root}/.git/hooks/${hookName}`,
      kind: "direct",
      location: "repository",
    })),
    uninstallGitHookAtPath: vi.fn((_hookName: string, path: string) => ({
      path,
      changed: true,
      removedFile: false,
    })),
    uninstallProjectGitHook: vi.fn((hookName: string, root: string) => ({
      path: `${root}/.git/hooks/${hookName}`,
      changed: true,
      removedFile: true,
    })),
  };
});

vi.mock("../lib/commit-heartbeat.js", () => ({ recordHooksWired: vi.fn() }));

vi.mock("../lib/confirmation.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/confirmation.js")>();
  return { ...actual, askConfirmation: vi.fn() };
});

vi.mock("../lib/hook-runtime.js", () => ({
  stageHookRuntime: vi.fn(),
  inspectGitHookEntrypoint: vi.fn(() => "ready"),
  hookRuntimePaths: vi.fn(() => ({ gitHookEntrypoint: "/home/u/.config/prim/prim-git-hook-v1" })),
}));

vi.mock("../lib/bin-path.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/bin-path.js")>();
  return {
    ...actual,
    commandMatchesBin: vi.fn(
      (command: string | undefined, bin: string) =>
        typeof command === "string" &&
        (command.trim() === bin ||
          (command.includes("-p @primitive.ai/prim@") && command.includes(bin))),
    ),
    pinnedHookCommand: vi.fn(
      (bin: string) =>
        `if [ -x '/opt/prim/node' ] && [ -f '/opt/prim/${bin}.js' ]; then '/opt/prim/node' '/opt/prim/${bin}.js'; else npx --yes -p @primitive.ai/prim@0.1.0-alpha.55 ${bin}; fi`,
    ),
    pinnedNpxCommand: vi.fn(
      (bin: string) => `npx --yes --ignore-scripts -p @primitive.ai/prim@0.1.0-alpha.55 ${bin}`,
    ),
  };
});

import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordHooksWired } from "../lib/commit-heartbeat.js";
import { askConfirmation } from "../lib/confirmation.js";
import {
  ensureEffectiveGitHook,
  ensureGitHookAtPath,
  gitHooksMode,
  hasCurrentHookBlock,
  managedHookBlock,
  projectGitHookTarget,
  projectHooksDir,
  resolveEffectiveGitHook,
  uninstallGitHookAtPath,
  uninstallProjectGitHook,
} from "../lib/git-hooks.js";
import { inspectGitHookEntrypoint, stageHookRuntime } from "../lib/hook-runtime.js";
import {
  EXIT_GLOBAL_HOOKS_NOT_INSTALLED,
  PRIM_BLOCK_END,
  PRIM_BLOCK_START,
  PRIM_GIT_HOOKS_DIR,
  detectHusky,
  installGlobalHooks,
  refreshOwnedGlobalHooks,
  registerHooksCommands,
  uninstallGlobalHooks,
} from "./hooks.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedLstatSync = vi.mocked(lstatSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedReaddirSync = vi.mocked(readdirSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedExecFileSync = vi.mocked(execFileSync);
const mockedEnsureEffectiveGitHook = vi.mocked(ensureEffectiveGitHook);
const mockedEnsureGitHookAtPath = vi.mocked(ensureGitHookAtPath);
const mockedUninstallGitHookAtPath = vi.mocked(uninstallGitHookAtPath);
const mockedUninstallProjectGitHook = vi.mocked(uninstallProjectGitHook);
const EXPLICIT = { context: "explicit" };
const HOOK_NAMES = ["pre-commit", "post-commit", "post-rewrite"] as const;

/** Paths each managed hook was wired to, in call order. */
const wiredPaths = (): string[] => mockedEnsureGitHookAtPath.mock.calls.map((call) => call[1]);

// core.hooksPath read for a given config level; `git config <level> --get …`.
const isGet = (args: readonly string[], level: string): boolean =>
  args[1] === level && args.includes("--get");
// The pointer-setting write; `git config --global core.hooksPath <dir>`.
const isSet = (args: readonly string[]): boolean =>
  args[0] === "config" && args[2] === "core.hooksPath";

beforeEach(() => {
  vi.resetAllMocks();
  mockedExistsSync.mockReturnValue(false);
  mockedReaddirSync.mockReturnValue([]);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registerHooksCommands", () => {
  it("registers the hooks command group", () => {
    const program = new Command();
    registerHooksCommands(program);

    const hooks = program.commands.find((c) => c.name() === "hooks");
    expect(hooks).toBeDefined();
  });

  it("registers install and uninstall subcommands", () => {
    const program = new Command();
    registerHooksCommands(program);

    const hooks = program.commands.find((c) => c.name() === "hooks");
    const subcommands = hooks?.commands.map((c) => c.name()) ?? [];

    expect(subcommands).toContain("install");
    expect(subcommands).toContain("uninstall");
  });

  it("project uninstall removes only project post-commit artifacts", async () => {
    const program = new Command();
    registerHooksCommands(program);

    await program.parseAsync(["hooks", "uninstall"], { from: "user" });

    expect(mockedUninstallProjectGitHook).toHaveBeenCalledWith("post-commit", "/fake/root");
    expect(mockedUninstallProjectGitHook).toHaveBeenCalledWith("post-rewrite", "/fake/root");
  });

  it("project uninstall removes pre-commit from a linked worktree's common Git directory", async () => {
    mockedExecFileSync.mockImplementation(((_cmd: string, args: string[]): string => {
      if (args[0] !== "rev-parse") return "";
      if (args.includes("--git-common-dir")) return "/fake/main/.git\n";
      return "/fake/worktree\n";
    }) as typeof execFileSync);
    mockedExistsSync.mockImplementation((path) => path === "/fake/main/.git/hooks/pre-commit");
    mockedReadFileSync.mockReturnValue("#!/bin/sh\nprim-pre-commit\n");
    const program = new Command();
    registerHooksCommands(program);

    await program.parseAsync(["hooks", "uninstall"], { from: "user" });

    expect(mockedUninstallGitHookAtPath).toHaveBeenCalledWith(
      "pre-commit",
      "/fake/main/.git/hooks/pre-commit",
      { husky: false },
    );
    expect(mockedUninstallProjectGitHook).toHaveBeenCalledWith("post-commit", "/fake/worktree");
    expect(mockedUninstallProjectGitHook).toHaveBeenCalledWith("post-rewrite", "/fake/worktree");
  });

  it("project uninstall recognizes an exact older pinned Prim pre-commit scaffold", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/fake/root/.git/hooks/pre-commit");
    mockedReadFileSync.mockReturnValue(`#!/bin/sh
# prim pre-commit hook — installed by: prim hooks install (prim-managed-hook)

{ if [ -x '/old/node' ] && [ -f '/old/dist/hooks/pre-commit.js' ]; then '/old/node' '/old/dist/hooks/pre-commit.js'; else npx --yes -p @primitive.ai/prim@0.1.0-alpha.54 prim-pre-commit; fi; } || true
`);
    const program = new Command();
    registerHooksCommands(program);

    await program.parseAsync(["hooks", "uninstall"], { from: "user" });

    expect(mockedUninstallGitHookAtPath).toHaveBeenCalledWith(
      "pre-commit",
      "/fake/root/.git/hooks/pre-commit",
      { husky: false },
    );
  });

  it("project uninstall strips only Prim's block from a Husky pre-commit hook", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/fake/root/.husky/pre-commit");
    mockedReadFileSync.mockReturnValue(
      `#!/bin/sh\nlint-staged\n${PRIM_BLOCK_START}\nprim-pre-commit\n${PRIM_BLOCK_END}\n`,
    );
    const program = new Command();
    registerHooksCommands(program);

    await program.parseAsync(["hooks", "uninstall"], { from: "user" });

    expect(mockedUninstallGitHookAtPath).toHaveBeenCalledTimes(1);
    expect(mockedUninstallGitHookAtPath).toHaveBeenCalledWith(
      "pre-commit",
      "/fake/root/.husky/pre-commit",
      { husky: true },
    );
  });

  it("project uninstall also removes pre-commit from a repo-local core.hooksPath", async () => {
    vi.mocked(projectGitHookTarget).mockReturnValue({
      gitRoot: "/fake/root",
      hooksDir: "/fake/root/.githooks",
      hookPath: "/fake/root/.githooks/pre-commit",
      kind: "direct",
      location: "worktree",
    });
    mockedExistsSync.mockImplementation((path) => path === "/fake/root/.githooks/pre-commit");
    mockedReadFileSync.mockReturnValue(
      `#!/bin/sh\nmake lint\n${PRIM_BLOCK_START}\n…\n${PRIM_BLOCK_END}\n`,
    );
    const program = new Command();
    registerHooksCommands(program);

    await program.parseAsync(["hooks", "uninstall"], { from: "user" });

    expect(mockedUninstallGitHookAtPath).toHaveBeenCalledWith(
      "pre-commit",
      "/fake/root/.githooks/pre-commit",
      { husky: false },
    );
  });

  it("project uninstall fails closed on an ambiguously modified Prim pre-commit hook", async () => {
    mockedExistsSync.mockImplementation((path) => path === "/fake/root/.git/hooks/pre-commit");
    mockedReadFileSync.mockReturnValue("#!/bin/sh\nprim-pre-commit --custom\nlint-staged\n");
    const program = new Command().exitOverride();
    registerHooksCommands(program);

    await expect(program.parseAsync(["hooks", "uninstall"], { from: "user" })).rejects.toThrow(
      /ownership could not be proven/,
    );

    expect(mockedUninstallGitHookAtPath).not.toHaveBeenCalled();
    expect(mockedUninstallProjectGitHook).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// detectHusky
// ---------------------------------------------------------------------------

describe("detectHusky", () => {
  it("returns false when .husky/ does not exist", () => {
    expect(detectHusky("/repo")).toBe(false);
  });

  it("returns true when .husky/_ exists", () => {
    mockedExistsSync.mockImplementation((p) => p === "/repo/.husky" || p === "/repo/.husky/_");
    expect(detectHusky("/repo")).toBe(true);
  });

  it("returns true when .husky/pre-commit exists", () => {
    mockedExistsSync.mockImplementation(
      (p) => p === "/repo/.husky" || p === "/repo/.husky/pre-commit",
    );
    expect(detectHusky("/repo")).toBe(true);
  });

  it("returns true when package.json has prepare script with husky", () => {
    mockedExistsSync.mockImplementation((p) => p === "/repo/.husky" || p === "/repo/package.json");
    mockedReadFileSync.mockReturnValue(JSON.stringify({ scripts: { prepare: "husky" } }));
    expect(detectHusky("/repo")).toBe(true);
  });

  it("returns true when package.json has postinstall script with husky", () => {
    mockedExistsSync.mockImplementation((p) => p === "/repo/.husky" || p === "/repo/package.json");
    mockedReadFileSync.mockReturnValue(
      JSON.stringify({ scripts: { postinstall: "husky install" } }),
    );
    expect(detectHusky("/repo")).toBe(true);
  });

  it("returns false when .husky/ exists but no confirming signals", () => {
    mockedExistsSync.mockImplementation((p) => p === "/repo/.husky");
    expect(detectHusky("/repo")).toBe(false);
  });

  it("returns false on malformed package.json", () => {
    mockedExistsSync.mockImplementation((p) => p === "/repo/.husky" || p === "/repo/package.json");
    mockedReadFileSync.mockReturnValue("{invalid json");
    expect(detectHusky("/repo")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// projectHooksDir
// ---------------------------------------------------------------------------

describe("projectHooksDir", () => {
  it("resolves the common hooks directory for a linked worktree", () => {
    mockedExecFileSync.mockImplementation(((_cmd: string, args: string[]): string => {
      if (args.includes("--git-common-dir")) return "/repo/.git\n";
      return "";
    }) as typeof execFileSync);

    expect(projectHooksDir("/repo-worktree")).toBe("/repo/.git/hooks");
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["rev-parse", "--git-common-dir"],
      expect.objectContaining({ cwd: "/repo-worktree" }),
    );
  });
});

// ---------------------------------------------------------------------------
// hooks install action (--yes / --non-interactive / --target / CI env)
// ---------------------------------------------------------------------------

describe("hooks install action", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    vi.unstubAllEnvs();
  });

  function buildProgram(): Command {
    const program = new Command();
    program.option("-y, --yes").option("--non-interactive").exitOverride();
    registerHooksCommands(program);
    return program;
  }

  const huskyDetected = (p: string) => p === "/fake/root/.husky" || p === "/fake/root/.husky/_";

  it("--yes installs to .husky when Husky is detected", async () => {
    mockedExistsSync.mockImplementation(huskyDetected);
    await buildProgram().parseAsync(["hooks", "install", "--yes"], { from: "user" });
    expect(wiredPaths()).toEqual(HOOK_NAMES.map((hook) => `/fake/root/.husky/${hook}`));
    expect(mockedEnsureGitHookAtPath).toHaveBeenCalledWith(
      "pre-commit",
      "/fake/root/.husky/pre-commit",
      { husky: true },
    );
  });

  it("--non-interactive throws when Husky is detected", async () => {
    mockedExistsSync.mockImplementation(huskyDetected);
    await expect(
      buildProgram().parseAsync(["hooks", "install", "--non-interactive"], { from: "user" }),
    ).rejects.toThrow(/--non-interactive set/);
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
    expect(mockedEnsureEffectiveGitHook).not.toHaveBeenCalled();
  });

  it("--target=husky bypasses Husky detection", async () => {
    await buildProgram().parseAsync(["hooks", "install", "--target=husky"], { from: "user" });
    expect(wiredPaths()[0]).toBe("/fake/root/.husky/pre-commit");
  });

  it("--target=git-hooks installs to .git/hooks even in non-TTY without warning", async () => {
    mockedExistsSync.mockImplementation(huskyDetected);
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], { from: "user" });
    expect(wiredPaths()[0]).toBe("/fake/root/.git/hooks/pre-commit");
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("warns when the chosen directory is not where Git runs hooks", async () => {
    vi.mocked(resolveEffectiveGitHook).mockReturnValue({
      gitRoot: "/fake/root",
      hooksDir: "/fake/root/.husky/_",
      hookPath: "/fake/root/.husky/pre-commit",
      kind: "husky_v9",
      location: "worktree",
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], { from: "user" });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("will not fire"));
    errSpy.mockRestore();
  });

  it("CI=1 fails fast when Husky is detected (same as --non-interactive)", async () => {
    mockedExistsSync.mockImplementation(huskyDetected);
    vi.stubEnv("CI", "1");
    await expect(buildProgram().parseAsync(["hooks", "install"], { from: "user" })).rejects.toThrow(
      /--non-interactive set/,
    );
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
  });

  it("installs pre-commit, post-commit, and post-rewrite hooks to .git/hooks", async () => {
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], {
      from: "user",
    });
    expect(wiredPaths()).toEqual(HOOK_NAMES.map((hook) => `/fake/root/.git/hooks/${hook}`));
    expect(stageHookRuntime).toHaveBeenCalledTimes(1);
    // An inactive checkout never runs prim, so no expectation starts yet.
    expect(recordHooksWired).not.toHaveBeenCalled();
  });

  it("starts doctor's expectation only in an active checkout", async () => {
    mockedExecFileSync.mockImplementation(((_cmd: string, args: string[]): string => {
      if (args.join(" ") === "config --get prim.active") return "true\n";
      if (args[0] !== "rev-parse") return "";
      if (args.includes("--git-common-dir")) return ".git\n";
      return "/fake/root\n";
    }) as typeof execFileSync);
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], { from: "user" });
    expect(recordHooksWired).toHaveBeenCalledWith("/fake/root", { onlyIfAbsent: false });
  });

  it("wires all three hooks where Git runs them when no Husky choice is needed", async () => {
    await buildProgram().parseAsync(["hooks", "install"], { from: "user" });
    expect(mockedEnsureEffectiveGitHook.mock.calls.map((call) => call[0])).toEqual([...HOOK_NAMES]);
    for (const hook of HOOK_NAMES) {
      expect(mockedEnsureEffectiveGitHook).toHaveBeenCalledWith(hook, "/fake/root", EXPLICIT);
    }
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
  });

  it("wires an active Husky repo where Git runs hooks, without prompting", async () => {
    mockedExistsSync.mockImplementation(huskyDetected);
    vi.mocked(resolveEffectiveGitHook).mockReturnValue({
      gitRoot: "/fake/root",
      hooksDir: "/fake/root/.husky/_",
      hookPath: "/fake/root/.husky/pre-commit",
      kind: "husky_v9",
      location: "worktree",
    });
    await buildProgram().parseAsync(["hooks", "install", "--non-interactive"], { from: "user" });
    expect(mockedEnsureEffectiveGitHook).toHaveBeenCalledTimes(3);
  });

  it("keeps install fail-soft when only post-rewrite dispatcher coverage is unavailable", async () => {
    mockedEnsureGitHookAtPath.mockImplementation((hookName, path) => {
      if (hookName === "post-rewrite") throw new Error("Husky post-rewrite dispatcher is missing");
      return { hookName, path, changed: true, kind: "direct", outcome: "created" };
    });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await buildProgram().parseAsync(["hooks", "install", "--target=husky"], { from: "user" });

    expect(wiredPaths()).toContain("/fake/root/.husky/post-commit");
    expect(errSpy).toHaveBeenCalledWith(
      expect.stringContaining("post-rewrite hook coverage is degraded"),
    );
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("prim hooks snippet post-rewrite"));
    errSpy.mockRestore();
  });

  it("leaves a hook outside the repository alone and fails when it is post-commit", async () => {
    mockedEnsureEffectiveGitHook.mockImplementation((hookName) => ({
      hookName,
      path: `/home/u/.config/git/hooks/${hookName}`,
      changed: false,
      kind: "direct",
      outcome: "external",
    }));
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await buildProgram().parseAsync(["hooks", "install"], { from: "user" });
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("outside the repository"));
    expect(process.exitCode).toBe(1);
    process.exitCode = undefined;
    errSpy.mockRestore();
  });

  it("fails the install when post-commit capture cannot be wired", async () => {
    mockedEnsureEffectiveGitHook.mockImplementation((hookName) => {
      if (hookName === "post-commit") throw new Error("malformed Prim post-commit markers");
      return { hookName, path: "/p", changed: false, kind: "direct", outcome: "unchanged" };
    });
    await expect(buildProgram().parseAsync(["hooks", "install"], { from: "user" })).rejects.toThrow(
      /malformed/,
    );
  });

  it("installs from a linked worktree without treating its .git file as a directory", async () => {
    mockedExecFileSync.mockImplementation(((_cmd: string, args: string[]): string => {
      if (args[0] !== "rev-parse") return "";
      if (args.includes("--git-common-dir")) return "/fake/main/.git\n";
      return "/fake/worktree\n";
    }) as typeof execFileSync);
    vi.mocked(resolveEffectiveGitHook).mockReturnValue({
      gitRoot: "/fake/worktree",
      hooksDir: "/fake/main/.git/hooks",
      hookPath: "/fake/main/.git/hooks/pre-commit",
      kind: "direct",
      location: "repository",
    });

    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], {
      from: "user",
    });

    expect(wiredPaths()).toEqual(HOOK_NAMES.map((hook) => `/fake/main/.git/hooks/${hook}`));
  });

  it("writes no hook file under prim.gitHooks=manual", async () => {
    vi.mocked(gitHooksMode).mockReturnValue("manual");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await buildProgram().parseAsync(["hooks", "install"], { from: "user" });
    expect(mockedEnsureEffectiveGitHook).not.toHaveBeenCalled();
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("prim.gitHooks=manual"));
    errSpy.mockRestore();
  });

  it("does not activate an unbound repo after a project install", async () => {
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], {
      from: "user",
    });
    expect(
      mockedExecFileSync.mock.calls.some(
        (call) => (call[1] as string[]).join(" ") === "config --local prim.active true",
      ),
    ).toBe(false);
  });
});

describe("hooks snippet", () => {
  it("prints the wiring block on STDOUT and guidance on STDERR without writing", async () => {
    const out = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const err = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const program = new Command().exitOverride();
    registerHooksCommands(program);

    await program.parseAsync(["hooks", "snippet", "post-rewrite"], { from: "user" });

    expect(out).toHaveBeenCalledWith(`${managedHookBlock("post-rewrite")}\n`);
    expect(String(err.mock.calls[0]?.[0])).toContain("/home/u/.config/prim/prim-git-hook-v1");
    expect(String(err.mock.calls[0]?.[0])).toContain("re-arms stdin");
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
    out.mockRestore();
    err.mockRestore();
  });

  it("rejects an unknown hook", async () => {
    const program = new Command().exitOverride();
    program.configureOutput({ writeErr: () => {} });
    registerHooksCommands(program);
    await expect(
      program.parseAsync(["hooks", "snippet", "pre-push"], { from: "user" }),
    ).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// User scope — global core.hooksPath (installGlobalHooks / uninstallGlobalHooks)
// ---------------------------------------------------------------------------

/** Make `git config <level> --get core.hooksPath` return chosen values. */
function stubHooksPath(v: { global?: string; system?: string }): void {
  mockedExecFileSync.mockImplementation(((_git: string, args: string[]): string => {
    if (isGet(args, "--global")) return v.global ?? "";
    if (isGet(args, "--system")) return v.system ?? "";
    return "";
  }) as unknown as typeof execFileSync);
}

const setCalls = () =>
  mockedExecFileSync.mock.calls.filter((c) => isSet((c[1] as string[] | undefined) ?? []));

describe("installGlobalHooks (user scope)", () => {
  const MACHINE_WIDE = { machineWide: true };

  it("changes nothing machine-wide without consent, and says how to opt in", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(installGlobalHooks()).toBe("not_requested");
    expect(stageHookRuntime).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("--global-hooks-path"));
    errSpy.mockRestore();
  });

  it("does not edit an existing foreign global hooks dir without consent", () => {
    stubHooksPath({ global: join(homedir(), ".config", "git", "hooks") });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(installGlobalHooks()).toBe("not_requested");
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("refreshes prim's own global hooks without asking", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    expect(installGlobalHooks()).toBe("refreshed");
    expect(mockedWriteFileSync).toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
  });

  it("writes standalone hooks and points core.hooksPath at prim's dir when nothing is set", () => {
    installGlobalHooks(MACHINE_WIDE); // default mock: global + system both unset
    const paths = mockedWriteFileSync.mock.calls.map((c) => String(c[0]));
    expect(paths).toContain(join(PRIM_GIT_HOOKS_DIR, "pre-commit"));
    expect(paths).toContain(join(PRIM_GIT_HOOKS_DIR, "post-commit"));
    expect(paths).toContain(join(PRIM_GIT_HOOKS_DIR, "post-rewrite"));
    expect(mockedMkdirSync).toHaveBeenCalledWith(PRIM_GIT_HOOKS_DIR, { recursive: true });
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "core.hooksPath", PRIM_GIT_HOOKS_DIR],
      expect.objectContaining({ timeout: 1_000 }),
    );
  });

  it("writes a recursion-safe, fail-soft global script", () => {
    installGlobalHooks(MACHINE_WIDE);
    const byPath = new Map(
      mockedWriteFileSync.mock.calls.map((c) => [String(c[0]), c[1] as string]),
    );
    const pre = byPath.get(join(PRIM_GIT_HOOKS_DIR, "pre-commit")) ?? "";
    const post = byPath.get(join(PRIM_GIT_HOOKS_DIR, "post-commit")) ?? "";
    const rewrite = byPath.get(join(PRIM_GIT_HOOKS_DIR, "post-rewrite")) ?? "";
    for (const [hook, script] of [
      ["pre-commit", pre],
      ["post-commit", post],
      ["post-rewrite", rewrite],
    ] as const) {
      // The frozen v1 block runs first; it gates on prim.active in the
      // entrypoint and never fails the hook. No version or machine path.
      expect(script.startsWith(`#!/bin/sh\n${managedHookBlock(hook)}\n`)).toBe(true);
      expect(script).not.toMatch(/@primitive\.ai\/prim@|\/opt\/prim|\bnpx\b|command -v/u);
      // --git-common-dir is NOT core.hooksPath-aware, so the chain never points
      // at this script; --git-path would be self-referential and must not appear.
      expect(script).toContain("git rev-parse --git-common-dir");
      expect(script).not.toContain("--git-path");
      expect(script.indexOf("# <<< prim")).toBeLessThan(script.indexOf("common_dir="));
    }
    expect(pre).toContain('"$repo_hook" "$@" || exit $?'); // a repo pre-commit can still block
    // A repo pre-commit is always chained: it may enforce checks of its own.
    expect(pre).not.toContain("grep -Fq");
    expect(post).toContain('"$repo_hook" "$@" || true'); // post-commit cannot block
    expect(rewrite).toContain('exec <"${prim_rewrite_stdin}"');
    expect(rewrite).toContain('"$repo_hook" "$@" || true');
  });

  it("does not chain a project-managed post-rewrite hook after a user-scope migration", async () => {
    installGlobalHooks(MACHINE_WIDE);
    const rewrite = String(
      mockedWriteFileSync.mock.calls.find(
        ([path]) => String(path) === join(PRIM_GIT_HOOKS_DIR, "post-rewrite"),
      )?.[1] ?? "",
    );
    const actualFs = await vi.importActual<typeof import("node:fs")>("node:fs");
    const actualChildProcess =
      await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const actualOs = await vi.importActual<typeof import("node:os")>("node:os");
    const directory = actualFs.mkdtempSync(join(actualOs.tmpdir(), "prim-global-rewrite-"));

    try {
      const binDirectory = join(directory, "bin");
      const hooksDirectory = join(directory, "common", "hooks");
      const chainLog = join(directory, "repo-hook-ran");
      actualFs.mkdirSync(binDirectory, { recursive: true });
      actualFs.mkdirSync(hooksDirectory, { recursive: true });
      actualFs.writeFileSync(
        join(binDirectory, "git"),
        `#!/bin/sh
if [ "$1" = "config" ]; then exit 0; fi
if [ "$1" = "rev-parse" ] && [ "$2" = "--git-common-dir" ]; then
  echo "$PRIM_TEST_COMMON_DIR"
  exit 0
fi
exit 1
`,
        { mode: 0o755 },
      );
      actualFs.writeFileSync(
        join(hooksDirectory, "post-rewrite"),
        `#!/bin/sh
# >>> prim post-rewrite hook >>>
touch "$PRIM_TEST_REPO_CHAIN_LOG"
# <<< prim post-rewrite hook <<<
`,
        { mode: 0o755 },
      );
      const globalHook = join(directory, "post-rewrite");
      actualFs.writeFileSync(globalHook, rewrite, { mode: 0o755 });

      actualChildProcess.execFileSync(globalHook, ["rebase"], {
        env: {
          ...process.env,
          PATH: `${binDirectory}:${process.env.PATH ?? "/usr/bin:/bin"}`,
          PRIM_CONFIG_DIR: join(directory, "no-prim-config"),
          PRIM_TEST_COMMON_DIR: join(directory, "common"),
          PRIM_TEST_REPO_CHAIN_LOG: chainLog,
        },
        input: `${"a".repeat(40)} ${"b".repeat(40)}\n`,
        stdio: ["pipe", "ignore", "pipe"],
      });

      expect(actualFs.existsSync(chainLog)).toBe(false);
    } finally {
      actualFs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("writes a pass-through stub for every non-prim client-side hook type (no shadowing)", () => {
    installGlobalHooks(MACHINE_WIDE);
    const byPath = new Map(
      mockedWriteFileSync.mock.calls.map((c) => [String(c[0]), c[1] as string]),
    );
    for (const name of ["commit-msg", "pre-push", "prepare-commit-msg", "post-merge"]) {
      const stub = byPath.get(join(PRIM_GIT_HOOKS_DIR, name));
      expect(stub, `stub for ${name}`).toBeDefined();
      // A stub forwards to the repo's real hook and never runs prim.
      expect(stub).toContain('exec "$repo_hook" "$@"');
      expect(stub).not.toContain("prim-");
      expect(stub).not.toContain("prim.active");
    }
  });

  it("refreshes scripts but does not re-set config when core.hooksPath is already prim's", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    installGlobalHooks(MACHINE_WIDE);
    expect(mockedWriteFileSync).toHaveBeenCalled();
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join(PRIM_GIT_HOOKS_DIR, "post-commit"),
      expect.stringContaining("prim global post-commit hook"),
      { mode: 0o755 },
    );
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join(PRIM_GIT_HOOKS_DIR, "post-rewrite"),
      expect.stringContaining("prim post-rewrite hook"),
      { mode: 0o755 },
    );
    const postCommit = mockedWriteFileSync.mock.calls.find(
      ([path]) => String(path) === join(PRIM_GIT_HOOKS_DIR, "post-commit"),
    )?.[1] as string;
    const postRewrite = mockedWriteFileSync.mock.calls.find(
      ([path]) => String(path) === join(PRIM_GIT_HOOKS_DIR, "post-rewrite"),
    )?.[1] as string;
    expect(postCommit.match(/# >>> prim post-commit hook >>>/gu)).toHaveLength(1);
    expect(postCommit.match(/# <<< prim post-commit hook <<</gu)).toHaveLength(1);
    expect(postRewrite.match(/# >>> prim post-rewrite hook >>>/gu)).toHaveLength(1);
    expect(postRewrite.match(/# <<< prim post-rewrite hook <<</gu)).toHaveLength(1);
    expect(setCalls()).toHaveLength(0);
  });

  it("overwrites the wholly-owned post-commit unconditionally instead of block-merging", () => {
    // The global dir is entirely Prim-owned, so post-commit is rewritten with a
    // plain writeFileSync like its siblings — never through the marker block-merge
    // whose `malformed Prim post-commit markers` guard previously failed setup on
    // a pre-existing/corrupt global hook.
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    installGlobalHooks(MACHINE_WIDE);
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join(PRIM_GIT_HOOKS_DIR, "post-commit"),
      expect.stringContaining("prim global post-commit hook"),
      { mode: 0o755 },
    );
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
  });

  it("refreshes both managed hooks when the owned global files contain corrupt markers", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue("malformed Prim hook markers\n");

    expect(refreshOwnedGlobalHooks()).toBe(true);

    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join(PRIM_GIT_HOOKS_DIR, "post-commit"),
      expect.stringContaining("prim global post-commit hook"),
      { mode: 0o755 },
    );
    expect(mockedWriteFileSync).toHaveBeenCalledWith(
      join(PRIM_GIT_HOOKS_DIR, "post-rewrite"),
      expect.stringContaining("prim global post-rewrite hook"),
      { mode: 0o755 },
    );
    expect(setCalls()).toHaveLength(0);
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
  });

  it("never swaps prim's global hooks for inert ones while the runtime is missing", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    vi.mocked(inspectGitHookEntrypoint).mockReturnValue("missing");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(refreshOwnedGlobalHooks()).toBe(false);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("not staged"));
    errSpy.mockRestore();
  });

  it.each([
    ["unset", ""],
    ["foreign", "/Users/example/.config/git/hooks"],
  ])("does not refresh an %s global hooks path", (_label, global) => {
    stubHooksPath({ global });

    expect(refreshOwnedGlobalHooks()).toBe(false);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("appends into an existing non-prim global hooksPath instead of hijacking it", () => {
    const existing = join(homedir(), ".config", "git", "hooks");
    stubHooksPath({ global: existing });
    installGlobalHooks(MACHINE_WIDE);
    // Every hook goes through the one engine; the entrypoint the block execs
    // gates on prim.active, so user scope stays opt-in in a foreign dir too.
    expect(wiredPaths()).toEqual(HOOK_NAMES.map((hook) => join(existing, hook)));
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0); // pointer left untouched
  });

  it("expands a leading ~ in the existing global hooksPath before writing", () => {
    stubHooksPath({ global: "~/.config/git/hooks" });
    installGlobalHooks(MACHINE_WIDE);
    expect(wiredPaths()).toEqual(
      HOOK_NAMES.map((hook) => join(homedir(), ".config", "git", "hooks", hook)),
    );
    expect(wiredPaths().some((p) => p.includes("~"))).toBe(false); // no literal tilde reached fs
  });

  it("leaves hook files and the pointer alone under a global prim.gitHooks=manual", () => {
    vi.mocked(gitHooksMode).mockReturnValue("manual");
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(installGlobalHooks(MACHINE_WIDE)).toBe("manual");
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("prim.gitHooks=manual"));
    errSpy.mockRestore();
  });

  it("does not override a system-level hooksPath without --force (reports the skip)", () => {
    stubHooksPath({ system: "/etc/git/hooks" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(installGlobalHooks(MACHINE_WIDE)).toBe("system_declined"); // an honest skip
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("system core.hooksPath"));
    errSpy.mockRestore();
  });

  it("overrides a system-level hooksPath with --force", () => {
    stubHooksPath({ system: "/etc/git/hooks" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(installGlobalHooks({ ...MACHINE_WIDE, force: true })).toBe("installed");
    expect(setCalls()).toHaveLength(1);
    errSpy.mockRestore();
  });
});

describe("uninstallGlobalHooks (user scope)", () => {
  it("removes prim scripts and unsets core.hooksPath when it is still ours", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    mockedExistsSync.mockReturnValue(true);
    installGlobalHooks();
    const contentByPath = new Map(
      mockedWriteFileSync.mock.calls.map((call) => [String(call[0]), String(call[1])]),
    );
    const names = [...contentByPath.keys()].map((path) =>
      path.slice(`${PRIM_GIT_HOOKS_DIR}/`.length),
    );
    mockedReaddirSync.mockReturnValue(names);
    mockedReadFileSync.mockImplementation((path) => contentByPath.get(String(path)) ?? "");
    mockedExecFileSync.mockClear();
    mockedUnlinkSync.mockClear();

    uninstallGlobalHooks();
    const unlinked = mockedUnlinkSync.mock.calls.map((c) => String(c[0]));
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "pre-commit"));
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "post-commit"));
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "post-rewrite"));
    // the pass-through stubs prim wrote are removed too, not orphaned
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "commit-msg"));
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "pre-push"));
    expect(mockedExecFileSync).toHaveBeenCalledWith(
      "git",
      ["config", "--global", "--unset", "core.hooksPath"],
      expect.objectContaining({ timeout: 1_000 }),
    );
  });

  it("fails closed without unsetting core.hooksPath when Prim's directory has a foreign entry", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(["foreign-tool"]);

    expect(() => uninstallGlobalHooks()).toThrow(/unexpected entry/);

    expect(mockedUnlinkSync).not.toHaveBeenCalled();
    expect(
      mockedExecFileSync.mock.calls.some((call) =>
        ((call[1] as string[] | undefined) ?? []).includes("--unset"),
      ),
    ).toBe(false);
  });

  it("fails closed when Prim's global hooks directory is a symlink", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    mockedLstatSync.mockReturnValue({
      isDirectory: () => false,
      isFile: () => false,
      isSymbolicLink: () => true,
      size: 0,
      mode: 0,
    } as ReturnType<typeof lstatSync>);

    expect(() => uninstallGlobalHooks()).toThrow(/not a Prim-owned directory/);

    expect(mockedReaddirSync).not.toHaveBeenCalled();
    expect(mockedUnlinkSync).not.toHaveBeenCalled();
    expect(
      mockedExecFileSync.mock.calls.some((call) =>
        ((call[1] as string[] | undefined) ?? []).includes("--unset"),
      ),
    ).toBe(false);
  });

  it("fails closed without deletion when an owned-name global hook was modified", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    mockedExistsSync.mockReturnValue(true);
    mockedReaddirSync.mockReturnValue(["pre-commit"]);
    mockedReadFileSync.mockReturnValue("#!/bin/sh\nforeign-tool\n");

    expect(() => uninstallGlobalHooks()).toThrow(/not an exact Prim-owned hook/);

    expect(mockedUnlinkSync).not.toHaveBeenCalled();
  });

  it("recognizes an exact pre-v1 global pre-commit scaffold with an older pinned invocation", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    mockedExistsSync.mockReturnValue(true);
    const older = `#!/bin/sh
# prim global pre-commit hook (core.hooksPath) — managed by prim; do not edit.
# Install/uninstall: prim hooks install|uninstall --scope user
# Runs prim only where activated — 'prim enable' (this repo) or
# 'git config --global prim.active true' (every repo). Chains to the repo's own
# hook regardless, so inactive repos are unaffected.
if [ "$(git config --get prim.active 2>/dev/null)" = "true" ]; then
{ if [ -x '/old/prim/node' ] && [ -f '/old/prim/prim-pre-commit.js' ]; then '/old/prim/node' '/old/prim/prim-pre-commit.js'; else npx --yes -p @primitive.ai/prim@0.1.0-alpha.54 prim-pre-commit; fi; } || true
fi
common_dir=$(git rev-parse --git-common-dir 2>/dev/null) || exit 0
repo_hook="$common_dir/hooks/pre-commit"
if [ -x "$repo_hook" ] && ! grep -q 'prim-managed-hook' "$repo_hook" 2>/dev/null; then
  "$repo_hook" "$@" || exit $?
fi
exit 0
`;
    mockedReaddirSync.mockReturnValue(["pre-commit"]);
    mockedReadFileSync.mockReturnValue(older);

    uninstallGlobalHooks();

    expect(mockedUnlinkSync).toHaveBeenCalledWith(join(PRIM_GIT_HOOKS_DIR, "pre-commit"));
    expect(
      mockedExecFileSync.mock.calls.some((call) =>
        ((call[1] as string[] | undefined) ?? []).includes("--unset"),
      ),
    ).toBe(true);
  });

  it("recognizes the current owned scripts it just wrote", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    mockedExistsSync.mockReturnValue(true);
    expect(refreshOwnedGlobalHooks()).toBe(true);
    const contentByPath = new Map(
      mockedWriteFileSync.mock.calls.map((call) => [String(call[0]), String(call[1])]),
    );
    mockedReaddirSync.mockReturnValue(["pre-commit", "post-commit", "post-rewrite"]);
    mockedReadFileSync.mockImplementation((path) => contentByPath.get(String(path)) ?? "");

    uninstallGlobalHooks();

    expect(mockedUnlinkSync).toHaveBeenCalledTimes(3);
  });

  it("strips prim's blocks from a foreign global hooks dir, leaving the files and the pointer", () => {
    const existing = join(homedir(), ".config", "git", "hooks");
    stubHooksPath({ global: existing });
    uninstallGlobalHooks();
    // The engine removes only prim's block, or a file prim provably created.
    expect(mockedUninstallGitHookAtPath.mock.calls.map((call) => call.slice(0, 2))).toEqual(
      HOOK_NAMES.map((hook) => [hook, join(existing, hook)]),
    );
    const unsetCalls = mockedExecFileSync.mock.calls.filter((c) =>
      ((c[1] as string[] | undefined) ?? []).includes("--unset"),
    );
    expect(unsetCalls).toHaveLength(0); // pointer untouched
  });

  it("reports nothing to remove when no global hooksPath is set", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    uninstallGlobalHooks();
    expect(mockedUnlinkSync).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("hooks install --scope user consent", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    // Pin the interactive ladder: CI runners export CI=true, which would make
    // every case below non-interactive and the TTY cases meaningless.
    vi.stubEnv("CI", "");
    vi.stubEnv("PRIM_NON_INTERACTIVE", "");
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, configurable: true });
    vi.unstubAllEnvs();
  });

  /** Root flags go before the verb, as the CLI parses them; `extra` after it. */
  async function install(flags: string[] = [], extra: string[] = []): Promise<void> {
    const program = new Command();
    program.option("-y, --yes").option("--non-interactive").exitOverride();
    registerHooksCommands(program);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await program.parseAsync([...flags, "hooks", "install", "--scope", "user", ...extra], {
        from: "user",
      });
    } finally {
      errSpy.mockRestore();
    }
  }

  const tty = () =>
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

  it("sets the pointer with --global-hooks-path, without prompting", async () => {
    await install([], ["--global-hooks-path"]);
    expect(setCalls()).toHaveLength(1);
    expect(askConfirmation).not.toHaveBeenCalled();
  });

  it("leaves the pointer unset without a TTY, and --yes does not count as consent", async () => {
    await install(["--yes"]);
    expect(setCalls()).toHaveLength(0);
    expect(askConfirmation).not.toHaveBeenCalled();
  });

  it.each([
    [true, 1],
    [false, 0],
  ])(
    "asks at a terminal (answer %s → %i pointer writes), even with --yes",
    async (answer, writes) => {
      tty();
      vi.mocked(askConfirmation).mockResolvedValue(answer);
      await install(["--yes"]);
      expect(askConfirmation).toHaveBeenCalledWith(
        expect.stringContaining("every repository"),
        process.stderr,
      );
      expect(setCalls()).toHaveLength(writes);
    },
  );

  it.each([
    ["CI", () => vi.stubEnv("CI", "1"), []],
    ["--non-interactive", () => {}, ["--non-interactive"]],
  ])("never prompts under %s", async (_label, arrange, flags) => {
    tty();
    arrange();
    await install(flags);
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
  });

  it("exits 3 when asked for global hooks it could not install, without prompting", async () => {
    tty();
    stubHooksPath({ system: "/etc/git/hooks" });
    await install([], ["--global-hooks-path"]);
    expect(setCalls()).toHaveLength(0);
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(EXIT_GLOBAL_HOOKS_NOT_INSTALLED);
    process.exitCode = undefined;
  });

  it("never asks a question manual mode would make moot", async () => {
    tty();
    vi.mocked(gitHooksMode).mockReturnValue("manual");
    await install();
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
  });

  it("names the shared dir it would edit when asking", async () => {
    tty();
    stubHooksPath({ global: "/Users/example/.config/git/hooks" });
    vi.mocked(askConfirmation).mockResolvedValue(false);
    await install();
    expect(askConfirmation).toHaveBeenCalledWith(
      expect.stringContaining("/Users/example/.config/git/hooks"),
      process.stderr,
    );
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
  });

  it("rejects --global-hooks-path outside user scope as a usage error, like setup", async () => {
    const program = new Command();
    program.exitOverride();
    registerHooksCommands(program);
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await program.parseAsync(["hooks", "install", "--global-hooks-path"], { from: "user" });
    expect(process.exitCode).toBe(2);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("only with --scope user"));
    expect(mockedEnsureEffectiveGitHook).not.toHaveBeenCalled();
    process.exitCode = undefined;
    errSpy.mockRestore();
  });

  it("neither prompts nor reports unwired after a consented install into a foreign dir", async () => {
    tty();
    stubHooksPath({ global: "/Users/example/.config/git/hooks" });
    vi.mocked(hasCurrentHookBlock).mockReturnValue(true);
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    await install(["--yes"]);
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(mockedEnsureGitHookAtPath).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already present"));
    logSpy.mockRestore();
  });

  it("does not prompt when the pointer is already prim's", async () => {
    tty();
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    await install();
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
  });
});
