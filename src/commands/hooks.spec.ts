import { Command } from "commander";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
  execSync: vi.fn(() => "/fake/root"),
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
  installToDotGit,
  installToHusky,
  registerHooksCommands,
} from "./hooks.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedMkdirSync = vi.mocked(mkdirSync);

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
