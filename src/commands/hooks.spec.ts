import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Mutable across tests (via vi.hoisted) so the execSync mock can model an
// unset (undefined) vs. set core.hooksPath without re-mocking the module.
const gitMock = vi.hoisted(() => ({ hooksPath: undefined as string | undefined }));

vi.mock("node:child_process", () => ({
  execSync: vi.fn((cmd: string, opts?: { cwd?: string }) => {
    const root = opts?.cwd ?? "/fake/root";
    // `git rev-parse --git-path hooks` — honors core.hooksPath; relative to cwd.
    if (cmd.includes("--git-path hooks")) {
      return gitMock.hooksPath ?? `${root}/.git/hooks`;
    }
    // `git config --get core.hooksPath` — non-zero exit when unset.
    if (cmd.includes("config --get core.hooksPath")) {
      if (gitMock.hooksPath === undefined) {
        throw new Error("core.hooksPath unset");
      }
      return gitMock.hooksPath;
    }
    return "/fake/root"; // git rev-parse --show-toplevel
  }),
}));

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

const mockQuestion = vi.fn();
const mockClose = vi.fn();

vi.mock("node:readline/promises", () => ({
  createInterface: vi.fn(() => ({
    question: mockQuestion,
    close: mockClose,
  })),
}));

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import {
  PRIM_BLOCK_END,
  PRIM_BLOCK_START,
  askConfirmation,
  containsPrimHook,
  detectHusky,
  installToGitHooks,
  installToHusky,
  registerHooksCommands,
  resolveGitHooksDir,
} from "./hooks.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

beforeEach(() => {
  vi.resetAllMocks();
  mockedExistsSync.mockReturnValue(false);
  gitMock.hooksPath = undefined; // default: core.hooksPath unset → .git/hooks
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
// askConfirmation
// ---------------------------------------------------------------------------

describe("askConfirmation", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
  });

  it("returns false when stdin is not a TTY", async () => {
    Object.defineProperty(process.stdin, "isTTY", {
      value: false,
      configurable: true,
    });
    expect(await askConfirmation("test?")).toBe(false);
  });

  it('returns true for "y"', async () => {
    mockQuestion.mockResolvedValue("y");
    expect(await askConfirmation("test?")).toBe(true);
  });

  it('returns true for "yes"', async () => {
    mockQuestion.mockResolvedValue("yes");
    expect(await askConfirmation("test?")).toBe(true);
  });

  it('returns true for "Y" (case-insensitive)', async () => {
    mockQuestion.mockResolvedValue("Y");
    expect(await askConfirmation("test?")).toBe(true);
  });

  it("returns false for empty input", async () => {
    mockQuestion.mockResolvedValue("");
    expect(await askConfirmation("test?")).toBe(false);
  });

  it('returns false for "n"', async () => {
    mockQuestion.mockResolvedValue("n");
    expect(await askConfirmation("test?")).toBe(false);
  });

  it("closes readline interface after use", async () => {
    mockQuestion.mockResolvedValue("y");
    await askConfirmation("test?");
    expect(mockClose).toHaveBeenCalled();
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
// installToGitHooks
// ---------------------------------------------------------------------------

describe("installToGitHooks", () => {
  it("creates .git/hooks/ directory if missing", () => {
    installToGitHooks("/repo");

    expect(mockedMkdirSync).toHaveBeenCalledWith("/repo/.git/hooks", {
      recursive: true,
    });
  });

  it("writes hook when no pre-commit exists", () => {
    installToGitHooks("/repo");

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

    installToGitHooks("/repo");

    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("refuses to overwrite non-prim existing hook", () => {
    mockedExistsSync.mockImplementation(
      (p) => p === "/repo/.git/hooks" || p === "/repo/.git/hooks/pre-commit",
    );
    mockedReadFileSync.mockReturnValue("#!/bin/sh\nlint-staged\n");

    const logSpy = vi.spyOn(console, "log");
    installToGitHooks("/repo");

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
});

// ---------------------------------------------------------------------------
// resolveGitHooksDir
// ---------------------------------------------------------------------------

describe("resolveGitHooksDir", () => {
  it("defaults to <repo>/.git/hooks when core.hooksPath is unset", () => {
    gitMock.hooksPath = undefined;
    expect(resolveGitHooksDir("/fake/root")).toEqual({
      dir: "/fake/root/.git/hooks",
      hooksPath: undefined,
      external: false,
    });
  });

  it("flags an out-of-repo core.hooksPath as external (shared/global dir)", () => {
    gitMock.hooksPath = "/global/hooks";
    expect(resolveGitHooksDir("/fake/root")).toEqual({
      dir: "/global/hooks",
      hooksPath: "/global/hooks",
      external: true,
    });
  });

  it("does not flag an in-repo core.hooksPath (e.g. .husky) as external", () => {
    gitMock.hooksPath = "/fake/root/.husky";
    expect(resolveGitHooksDir("/fake/root").external).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// hooks install — external core.hooksPath gate (policy A: confirm-to-install)
// ---------------------------------------------------------------------------

describe("hooks install with external core.hooksPath", () => {
  const originalIsTTY = process.stdin.isTTY;

  beforeEach(() => {
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    gitMock.hooksPath = "/global/hooks"; // resolves outside /fake/root → external
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

  it("--yes installs into the shared hooks dir with a STDERR warning", async () => {
    const errSpy = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await buildProgram().parseAsync(["hooks", "install", "--yes", "--target=git-hooks"], {
      from: "user",
    });
    const paths = mockedWriteFileSync.mock.calls.map((c) => c[0]);
    expect(paths).toContain("/global/hooks/pre-commit");
    expect(paths).toContain("/global/hooks/post-commit");
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("core.hooksPath"));
    errSpy.mockRestore();
  });

  it("--non-interactive refuses and writes nothing", async () => {
    await expect(
      buildProgram().parseAsync(["hooks", "install", "--non-interactive", "--target=git-hooks"], {
        from: "user",
      }),
    ).rejects.toThrow(/core\.hooksPath/);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("interactive decline writes nothing", async () => {
    mockQuestion.mockResolvedValue("n");
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], { from: "user" });
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("interactive accept installs into the shared dir", async () => {
    mockQuestion.mockResolvedValue("y");
    await buildProgram().parseAsync(["hooks", "install", "--target=git-hooks"], { from: "user" });
    expect(mockedWriteFileSync.mock.calls.map((c) => c[0])).toContain("/global/hooks/pre-commit");
  });
});
