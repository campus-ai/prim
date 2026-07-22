import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "/fake/root"),
  // `git rev-parse --show-toplevel` (via gitToplevel) → the repo root; every
  // `git config --get` reads empty (unset). Reset restores this between tests,
  // so an "unset global + unset system" case needs no per-test setup.
  execFileSync: vi.fn((_cmd, args) =>
    Array.isArray(args) && args[0] === "rev-parse" ? "/fake/root" : "",
  ),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

vi.mock("../lib/bin-path.js", () => ({
  pinnedHookCommand: vi.fn(
    (bin: string) =>
      `if [ -x '/opt/prim/node' ] && [ -f '/opt/prim/${bin}.js' ]; then '/opt/prim/node' '/opt/prim/${bin}.js'; else npx --yes -p @primitive.ai/prim@0.1.0-alpha.55 ${bin}; fi`,
  ),
}));

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  PRIM_BLOCK_END,
  PRIM_BLOCK_START,
  PRIM_GIT_HOOKS_DIR,
  containsPrimHook,
  detectHusky,
  installGlobalHooks,
  installToDotGit,
  installToHusky,
  registerHooksCommands,
  uninstallGlobalHooks,
} from "./hooks.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);
const mockedUnlinkSync = vi.mocked(unlinkSync);
const mockedExecFileSync = vi.mocked(execFileSync);

// core.hooksPath read for a given config level; `git config <level> --get …`.
const isGet = (args: readonly string[], level: string): boolean =>
  args[1] === level && args.includes("--get");
// The pointer-setting write; `git config --global core.hooksPath <dir>`.
const isSet = (args: readonly string[]): boolean =>
  args[0] === "config" && args[2] === "core.hooksPath";

beforeEach(() => {
  vi.resetAllMocks();
  mockedExistsSync.mockReturnValue(false);
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
// containsPrimHook
// ---------------------------------------------------------------------------

describe("containsPrimHook", () => {
  it("returns true when content includes prim-pre-commit", () => {
    expect(containsPrimHook("some\nprim-pre-commit\nstuff")).toBe(true);
  });

  it("returns true when content includes block markers", () => {
    expect(containsPrimHook(`${PRIM_BLOCK_START}\nprim-pre-commit\n${PRIM_BLOCK_END}`)).toBe(true);
  });

  it("returns false on empty string", () => {
    expect(containsPrimHook("")).toBe(false);
  });

  it("returns false when prim is not mentioned", () => {
    expect(containsPrimHook("#!/bin/sh\nlint-staged")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// installToHusky
// ---------------------------------------------------------------------------

describe("installToHusky", () => {
  it("creates new .husky/pre-commit when file does not exist", () => {
    installToHusky("/repo");

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [path, content, opts] = mockedWriteFileSync.mock.calls[0];
    expect(path).toBe("/repo/.husky/pre-commit");
    expect(content).toContain("#!/bin/sh");
    expect(content).toContain(PRIM_BLOCK_START);
    expect(content).toContain(PRIM_BLOCK_END);
    expect(opts).toEqual({ mode: 0o755 });
  });

  it("appends prim block to existing .husky/pre-commit", () => {
    const existingContent = "#!/bin/sh\nlint-staged\n";
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(existingContent);

    installToHusky("/repo");

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const written = mockedWriteFileSync.mock.calls[0][1] as string;
    expect(written).toContain(existingContent);
    expect(written).toContain(PRIM_BLOCK_START);
    expect(written).toContain("prim-pre-commit");
  });

  it("skips when prim is already installed", () => {
    mockedExistsSync.mockReturnValue(true);
    mockedReadFileSync.mockReturnValue(
      `#!/bin/sh\n${PRIM_BLOCK_START}\nprim-pre-commit\n${PRIM_BLOCK_END}\n`,
    );

    installToHusky("/repo");

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// installToDotGit
// ---------------------------------------------------------------------------

describe("installToDotGit", () => {
  it("creates .git/hooks/ directory if missing", () => {
    installToDotGit("/repo");

    expect(mockedMkdirSync).toHaveBeenCalledWith("/repo/.git/hooks", {
      recursive: true,
    });
  });

  it("writes hook when no pre-commit exists", () => {
    installToDotGit("/repo");

    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [path, content, opts] = mockedWriteFileSync.mock.calls[0];
    expect(path).toBe("/repo/.git/hooks/pre-commit");
    expect(content).toContain("prim-pre-commit");
    expect(opts).toEqual({ mode: 0o755 });
  });

  it("reports already installed when existing hook contains prim-pre-commit", () => {
    mockedExistsSync.mockImplementation(
      (p) => p === "/repo/.git/hooks" || p === "/repo/.git/hooks/pre-commit",
    );
    mockedReadFileSync.mockReturnValue("#!/bin/sh\nprim-pre-commit\n");

    installToDotGit("/repo");

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("refuses to overwrite non-prim existing hook", () => {
    mockedExistsSync.mockImplementation(
      (p) => p === "/repo/.git/hooks" || p === "/repo/.git/hooks/pre-commit",
    );
    mockedReadFileSync.mockReturnValue("#!/bin/sh\nlint-staged\n");

    const logSpy = vi.spyOn(console, "log");
    installToDotGit("/repo");

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already exists"));
    logSpy.mockRestore();
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
    expect(mockedWriteFileSync.mock.calls[0][0]).toBe("/fake/root/.husky/pre-commit");
  });

  it("--non-interactive throws when Husky is detected", async () => {
    mockedExistsSync.mockImplementation(huskyDetected);
    await expect(
      buildProgram().parseAsync(["hooks", "install", "--non-interactive"], { from: "user" }),
    ).rejects.toThrow(/--non-interactive set/);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("--target=husky bypasses Husky detection", async () => {
    await buildProgram().parseAsync(["hooks", "install", "--target=husky"], { from: "user" });
    expect(mockedWriteFileSync.mock.calls[0][0]).toBe("/fake/root/.husky/pre-commit");
  });

  it("--target=git-hooks installs to .git/hooks even in non-TTY without warning", async () => {
    mockedExistsSync.mockImplementation(huskyDetected);
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], { from: "user" });
    expect(mockedWriteFileSync.mock.calls[0][0]).toBe("/fake/root/.git/hooks/pre-commit");
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("CI=1 fails fast when Husky is detected (same as --non-interactive)", async () => {
    mockedExistsSync.mockImplementation(huskyDetected);
    vi.stubEnv("CI", "1");
    await expect(buildProgram().parseAsync(["hooks", "install"], { from: "user" })).rejects.toThrow(
      /--non-interactive set/,
    );
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("installs both pre-commit and post-commit hooks to .git/hooks", async () => {
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], {
      from: "user",
    });
    const paths = mockedWriteFileSync.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/fake/root/.git/hooks/pre-commit");
    expect(paths).toContain("/fake/root/.git/hooks/post-commit");
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
  it("writes standalone hooks and points core.hooksPath at prim's dir when nothing is set", () => {
    installGlobalHooks(); // default mock: global + system both unset
    const paths = mockedWriteFileSync.mock.calls.map((c) => String(c[0]));
    expect(paths).toContain(join(PRIM_GIT_HOOKS_DIR, "pre-commit"));
    expect(paths).toContain(join(PRIM_GIT_HOOKS_DIR, "post-commit"));
    expect(mockedMkdirSync).toHaveBeenCalledWith(PRIM_GIT_HOOKS_DIR, { recursive: true });
    expect(mockedExecFileSync).toHaveBeenCalledWith("git", [
      "config",
      "--global",
      "core.hooksPath",
      PRIM_GIT_HOOKS_DIR,
    ]);
  });

  it("writes a recursion-safe, fail-soft global script", () => {
    installGlobalHooks();
    const byPath = new Map(
      mockedWriteFileSync.mock.calls.map((c) => [String(c[0]), c[1] as string]),
    );
    const pre = byPath.get(join(PRIM_GIT_HOOKS_DIR, "pre-commit")) ?? "";
    const post = byPath.get(join(PRIM_GIT_HOOKS_DIR, "post-commit")) ?? "";
    // Opt-in gate: prim runs only where prim.active is true.
    expect(pre).toContain("git config --get prim.active");
    // --git-common-dir is NOT core.hooksPath-aware, so the chain never points at
    // this script; --git-path would be self-referential and must not appear.
    expect(pre).toContain("git rev-parse --git-common-dir");
    expect(pre).not.toContain("--git-path");
    expect(pre).toContain('"$repo_hook" "$@" || exit $?'); // a repo pre-commit can still block
    expect(pre).toContain("} || true"); // prim never breaks a commit
    expect(pre).toContain("[ -x '/opt/prim/node' ]");
    expect(pre).toContain("@primitive.ai/prim@0.1.0-alpha.55 prim-pre-commit");
    expect(pre).not.toContain("command -v");
    expect(pre).not.toContain("./node_modules");
    expect(pre).not.toMatch(/@latest|@primitive\.ai\/prim\s/);
    expect(post).toContain('"$repo_hook" "$@" || true'); // post-commit cannot block
    // STRUCTURAL: the prim invocation must be NESTED inside the gate — between
    // the `prim.active` check and the chain — not merely present somewhere.
    // Independent `toContain`s would pass on an ungated invocation (the H2 bug).
    const gateAt = pre.indexOf("git config --get prim.active");
    const binAt = pre.indexOf("prim-pre-commit");
    const chainAt = pre.indexOf("common_dir=");
    expect(gateAt).toBeGreaterThan(-1);
    expect(binAt).toBeGreaterThan(gateAt); // invocation is after the gate opens
    expect(binAt).toBeLessThan(chainAt); // and before the chain — i.e. inside the gate
  });

  it("writes a pass-through stub for every non-prim client-side hook type (no shadowing)", () => {
    installGlobalHooks();
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
    installGlobalHooks();
    expect(mockedWriteFileSync).toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
  });

  it("appends into an existing non-prim global hooksPath instead of hijacking it", () => {
    const existing = join(homedir(), ".config", "git", "hooks");
    stubHooksPath({ global: existing });
    installGlobalHooks();
    const paths = mockedWriteFileSync.mock.calls.map((c) => String(c[0]));
    expect(paths).toContain(join(existing, "pre-commit"));
    expect(paths).toContain(join(existing, "post-commit"));
    expect(setCalls()).toHaveLength(0); // pointer left untouched
    const pre = mockedWriteFileSync.mock.calls.find(
      (c) => String(c[0]) === join(existing, "pre-commit"),
    )?.[1] as string;
    expect(pre).toContain(PRIM_BLOCK_START); // a marker block, not the standalone script
    expect(pre).toContain("prim-pre-commit");
    // H2 fix: the coexist-append block is GATED too, so user scope stays opt-in
    // even when appended into a foreign core.hooksPath dir.
    expect(pre).toContain("git config --get prim.active");
  });

  it("expands a leading ~ in the existing global hooksPath before writing", () => {
    stubHooksPath({ global: "~/.config/git/hooks" });
    installGlobalHooks();
    const paths = mockedWriteFileSync.mock.calls.map((c) => String(c[0]));
    expect(paths).toContain(join(homedir(), ".config", "git", "hooks", "pre-commit"));
    expect(paths.some((p) => p.includes("~"))).toBe(false); // no literal tilde reached fs
  });

  it("does not override a system-level hooksPath without --force (returns false to signal the skip)", () => {
    stubHooksPath({ system: "/etc/git/hooks" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(installGlobalHooks()).toBe(false); // caller can report an honest skip
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(setCalls()).toHaveLength(0);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("system core.hooksPath"));
    errSpy.mockRestore();
  });

  it("overrides a system-level hooksPath with --force (returns true)", () => {
    stubHooksPath({ system: "/etc/git/hooks" });
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(installGlobalHooks({ force: true })).toBe(true);
    expect(setCalls()).toHaveLength(1);
    errSpy.mockRestore();
  });
});

describe("uninstallGlobalHooks (user scope)", () => {
  it("removes prim scripts and unsets core.hooksPath when it is still ours", () => {
    stubHooksPath({ global: PRIM_GIT_HOOKS_DIR });
    mockedExistsSync.mockReturnValue(true);
    uninstallGlobalHooks();
    const unlinked = mockedUnlinkSync.mock.calls.map((c) => String(c[0]));
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "pre-commit"));
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "post-commit"));
    // the pass-through stubs prim wrote are removed too, not orphaned
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "commit-msg"));
    expect(unlinked).toContain(join(PRIM_GIT_HOOKS_DIR, "pre-push"));
    expect(mockedExecFileSync).toHaveBeenCalledWith("git", [
      "config",
      "--global",
      "--unset",
      "core.hooksPath",
    ]);
  });

  it("strips the prim block from a foreign hook that has other content, leaving the file + pointer", () => {
    const existing = join(homedir(), ".config", "git", "hooks");
    stubHooksPath({ global: existing });
    mockedExistsSync.mockReturnValue(true);
    // A foreign tool's hook with prim appended — stripping leaves the tool's line.
    mockedReadFileSync.mockReturnValue(
      `#!/bin/sh\nlint-staged\n${PRIM_BLOCK_START}\nprim-pre-commit\n${PRIM_BLOCK_END}\n`,
    );
    uninstallGlobalHooks();
    const unsetCalls = mockedExecFileSync.mock.calls.filter((c) =>
      ((c[1] as string[] | undefined) ?? []).includes("--unset"),
    );
    expect(unsetCalls).toHaveLength(0); // pointer untouched
    expect(mockedUnlinkSync).not.toHaveBeenCalled(); // file has other content — kept
    const written = mockedWriteFileSync.mock.calls.map((c) => c[1] as string);
    expect(written.some((w) => w.includes("lint-staged"))).toBe(true);
    expect(written.every((w) => !w.includes("prim-pre-commit"))).toBe(true);
  });

  it("unlinks a prim-CREATED foreign hook (provenance marker + shebang only) instead of orphaning it", () => {
    const existing = join(homedir(), ".config", "git", "hooks");
    stubHooksPath({ global: existing });
    mockedExistsSync.mockReturnValue(true);
    // prim created this file (mergePrimBlock else-branch): shebang + provenance
    // marker + prim block only.
    mockedReadFileSync.mockReturnValue(
      `#!/bin/sh\n# prim-created-hook\n\n${PRIM_BLOCK_START}\nprim-pre-commit\n${PRIM_BLOCK_END}\n`,
    );
    uninstallGlobalHooks();
    expect(mockedUnlinkSync).toHaveBeenCalledWith(join(existing, "pre-commit"));
  });

  it("does NOT unlink a user's shebang-only hook prim merely appended to (no provenance marker)", () => {
    const existing = join(homedir(), ".config", "git", "hooks");
    stubHooksPath({ global: existing });
    mockedExistsSync.mockReturnValue(true);
    // A user's own shebang-only hook prim appended to — NO prim-created marker.
    mockedReadFileSync.mockReturnValue(
      `#!/bin/sh\n${PRIM_BLOCK_START}\nprim-pre-commit\n${PRIM_BLOCK_END}\n`,
    );
    uninstallGlobalHooks();
    expect(mockedUnlinkSync).not.toHaveBeenCalled(); // never delete a user's file
    expect(mockedWriteFileSync).toHaveBeenCalled(); // block stripped, file kept
  });

  it("reports nothing to remove when no global hooksPath is set", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    uninstallGlobalHooks();
    expect(mockedUnlinkSync).not.toHaveBeenCalled();
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});
