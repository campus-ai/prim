import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 1),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  renameSync: vi.fn(),
}));

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import {
  SKILL_BEGIN,
  SKILL_END,
  applyBlock,
  composeBlock,
  detectNewline,
  detectTargets,
  registerSkillCommands,
  removeBlock,
  runInstall,
  runStatus,
  runUninstall,
} from "./skill.js";

const mockedExistsSync = vi.mocked(existsSync);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedRenameSync = vi.mocked(renameSync);

const SKILL_CONTENT = "---\nname: prim\n---\n\nbody\n";

/** Configure fs mocks so loadSkill() resolves and an optional target file is readable. */
function fsFixture(opts: { target?: string; targetContent?: string } = {}) {
  mockedExistsSync.mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("SKILL.md")) return true;
    if (opts.target && s === opts.target) return opts.targetContent !== undefined;
    return false;
  });
  mockedReadFileSync.mockImplementation((p) => {
    const s = String(p);
    if (s.endsWith("SKILL.md")) return SKILL_CONTENT;
    if (opts.target && s === opts.target) return opts.targetContent ?? "";
    return "";
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mockedExistsSync.mockReturnValue(false);
});

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

describe("registerSkillCommands", () => {
  it("registers the skill command group", () => {
    const program = new Command();
    registerSkillCommands(program);
    expect(program.commands.find((c) => c.name() === "skill")).toBeDefined();
  });

  it("registers install, uninstall, and status subcommands", () => {
    const program = new Command();
    registerSkillCommands(program);
    const skill = program.commands.find((c) => c.name() === "skill");
    const subcommands = skill?.commands.map((c) => c.name()) ?? [];
    expect(subcommands).toContain("install");
    expect(subcommands).toContain("uninstall");
    expect(subcommands).toContain("status");
  });
});

// ---------------------------------------------------------------------------
// detectTargets
// ---------------------------------------------------------------------------

describe("detectTargets", () => {
  it("returns an empty list when no candidates exist", () => {
    expect(detectTargets("/repo")).toEqual([]);
  });

  it("returns a single match", () => {
    mockedExistsSync.mockImplementation((p) => p === "/repo/CLAUDE.md");
    expect(detectTargets("/repo")).toEqual(["CLAUDE.md"]);
  });

  it("returns multiple matches", () => {
    mockedExistsSync.mockImplementation(
      (p) => p === "/repo/CLAUDE.md" || p === "/repo/.cursor/rules",
    );
    expect(detectTargets("/repo")).toEqual(["CLAUDE.md", ".cursor/rules"]);
  });
});

// ---------------------------------------------------------------------------
// detectNewline
// ---------------------------------------------------------------------------

describe("detectNewline", () => {
  it("returns LF for content with only LF", () => {
    expect(detectNewline("a\nb\n")).toBe("\n");
  });

  it("returns CRLF when CRLF is present", () => {
    expect(detectNewline("a\r\nb\r\n")).toBe("\r\n");
  });
});

// ---------------------------------------------------------------------------
// composeBlock
// ---------------------------------------------------------------------------

describe("composeBlock", () => {
  it("wraps content in BEGIN/END markers with the requested EOL", () => {
    const out = composeBlock("body\n", "\n");
    expect(out).toBe(`${SKILL_BEGIN}\nbody\n\n${SKILL_END}`);
  });

  it("normalises CRLF skill content to LF when EOL is LF", () => {
    const out = composeBlock("a\r\nb\r\n", "\n");
    expect(out).toBe(`${SKILL_BEGIN}\na\nb\n\n${SKILL_END}`);
  });

  it("normalises LF skill content to CRLF when EOL is CRLF", () => {
    const out = composeBlock("a\nb\n", "\r\n");
    expect(out).toBe(`${SKILL_BEGIN}\r\na\r\nb\r\n\r\n${SKILL_END}`);
  });
});

// ---------------------------------------------------------------------------
// applyBlock
// ---------------------------------------------------------------------------

describe("applyBlock", () => {
  it("creates a block followed by EOL when existing is empty", () => {
    expect(applyBlock("", "BLOCK", "\n")).toBe("BLOCK\n");
  });

  it("appends with no extra separator when existing ends with EOL", () => {
    expect(applyBlock("# h\n", "BLOCK", "\n")).toBe("# h\nBLOCK\n");
  });

  it("inserts a separator when existing does not end with EOL", () => {
    expect(applyBlock("# h", "BLOCK", "\n")).toBe("# h\nBLOCK\n");
  });

  it("splices when both markers already present", () => {
    const existing = `pre\n${SKILL_BEGIN}\nold\n${SKILL_END}\npost\n`;
    const block = `${SKILL_BEGIN}\nnew\n${SKILL_END}`;
    expect(applyBlock(existing, block, "\n")).toBe(`pre\n${block}\npost\n`);
  });
});

// ---------------------------------------------------------------------------
// removeBlock
// ---------------------------------------------------------------------------

describe("removeBlock", () => {
  it("returns null when markers are absent", () => {
    expect(removeBlock("# h\nbody\n")).toBeNull();
  });

  it("strips the block and trims a stray blank line", () => {
    const existing = `# h\n${SKILL_BEGIN}\nbody\n${SKILL_END}\n`;
    expect(removeBlock(existing)).toBe("# h\n");
  });

  it("preserves CRLF endings around the spliced block", () => {
    const existing = `# h\r\n${SKILL_BEGIN}\r\nbody\r\n${SKILL_END}\r\n`;
    expect(removeBlock(existing)).toBe("# h\r\n");
  });
});

// ---------------------------------------------------------------------------
// runInstall
// ---------------------------------------------------------------------------

describe("runInstall", () => {
  it("returns 1 and prints candidates when targets are ambiguous", () => {
    mockedExistsSync.mockImplementation(
      (p) => p === "/repo/CLAUDE.md" || p === "/repo/.cursor/rules",
    );
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runInstall("/repo", {})).toBe(1);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Multiple rules files"));
    errSpy.mockRestore();
  });

  it("creates the default rules file when no candidates exist", () => {
    fsFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", {})).toBe(0);
    expect(mockedWriteFileSync).toHaveBeenCalledOnce();
    const [path, content] = mockedWriteFileSync.mock.calls[0];
    expect(String(path)).toBe("/repo/CLAUDE.md.tmp");
    expect(String(content)).toContain(SKILL_BEGIN);
    expect(String(content)).toContain(SKILL_END);
    expect(mockedRenameSync).toHaveBeenCalledWith("/repo/CLAUDE.md.tmp", "/repo/CLAUDE.md");
    logSpy.mockRestore();
  });

  it("appends to an existing rules file without the block", () => {
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: "# CLAUDE.md\n" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", {})).toBe(0);
    const written = String(mockedWriteFileSync.mock.calls[0][1]);
    expect(written.startsWith("# CLAUDE.md\n")).toBe(true);
    expect(written).toContain(SKILL_BEGIN);
  });

  it("is a no-op on re-run (idempotent)", () => {
    const block = composeBlock(SKILL_CONTENT, "\n");
    const settled = `# CLAUDE.md\n${block}\n`;
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: settled });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", {})).toBe(0);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("already up to date"));
    logSpy.mockRestore();
  });

  it("preserves CRLF line endings in the existing target", () => {
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: "# CLAUDE.md\r\n" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", {})).toBe(0);
    const written = String(mockedWriteFileSync.mock.calls[0][1]);
    expect(written).toContain(`${SKILL_BEGIN}\r\n`);
    expect(written).toContain(`\r\n${SKILL_END}`);
    expect(written).not.toMatch(/(?<!\r)\n/);
  });

  it("respects --target override", () => {
    fsFixture({ target: "/repo/custom/rules.md", targetContent: "" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", { target: "custom/rules.md" })).toBe(0);
    const [path] = mockedWriteFileSync.mock.calls[0];
    expect(String(path)).toBe("/repo/custom/rules.md.tmp");
    expect(mockedRenameSync).toHaveBeenCalledWith(
      "/repo/custom/rules.md.tmp",
      "/repo/custom/rules.md",
    );
  });

  it("prints a unified diff and skips writes in --dry-run", () => {
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: "# CLAUDE.md\n" });
    const stdoutSpy = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    expect(runInstall("/repo", { dryRun: true })).toBe(0);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    const written = String(stdoutSpy.mock.calls[0][0]);
    expect(written).toContain("---");
    expect(written).toContain("+++");
    expect(written).toContain(SKILL_BEGIN);
    stdoutSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// runUninstall
// ---------------------------------------------------------------------------

describe("runUninstall", () => {
  it("returns 0 with informational message when target is absent", () => {
    fsFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runUninstall("/repo", {})).toBe(0);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not present"));
    logSpy.mockRestore();
  });

  it("returns 0 without writing when target lacks the block", () => {
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: "# CLAUDE.md\n" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runUninstall("/repo", {})).toBe(0);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
  });

  it("removes the block when present", () => {
    const existing = `# CLAUDE.md\n${SKILL_BEGIN}\nbody\n${SKILL_END}\n`;
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: existing });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runUninstall("/repo", {})).toBe(0);
    const written = String(mockedWriteFileSync.mock.calls[0][1]);
    expect(written).toBe("# CLAUDE.md\n");
    expect(mockedRenameSync).toHaveBeenCalledWith("/repo/CLAUDE.md.tmp", "/repo/CLAUDE.md");
  });
});

// ---------------------------------------------------------------------------
// runStatus
// ---------------------------------------------------------------------------

describe("runStatus", () => {
  it("returns 1 when no rules file exists", () => {
    fsFixture();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runStatus("/repo", {})).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No rules file"));
    logSpy.mockRestore();
  });

  it("returns 0 when the block is installed", () => {
    const existing = `${SKILL_BEGIN}\nbody\n${SKILL_END}\n`;
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: existing });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runStatus("/repo", {})).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("PRIM SKILL v1 installed"));
    logSpy.mockRestore();
  });

  it("returns 1 when the block is absent from an existing rules file", () => {
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: "# CLAUDE.md\n" });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runStatus("/repo", {})).toBe(1);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No PRIM SKILL block"));
    logSpy.mockRestore();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
