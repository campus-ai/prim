import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const TMP_ID = "00000000-0000-4000-8000-000000000001";

vi.mock("node:crypto", () => ({ randomUUID: vi.fn(() => TMP_ID) }));
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  openSync: vi.fn(() => 1),
  fsyncSync: vi.fn(),
  closeSync: vi.fn(),
  renameSync: vi.fn(),
  rmSync: vi.fn(),
}));

// The Claude branch delegates to the skills-directory plugin module; mock it so
// these tests assert routing (claude → plugin, never a rules-file write). The
// plugin's real behavior is covered by claude-plugin.spec.ts against real fs.
vi.mock("./claude-plugin.js", () => ({
  installClaudePlugin: vi.fn(),
  uninstallClaudePlugin: vi.fn(),
  statusClaudePlugin: vi.fn(),
}));

import { randomUUID } from "node:crypto";
import {
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installClaudePlugin, statusClaudePlugin, uninstallClaudePlugin } from "./claude-plugin.js";
import {
  SKILL_BEGIN,
  SKILL_END,
  applyBlock,
  atomicWrite,
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
const mockedRandomUUID = vi.mocked(randomUUID);
const mockedReadFileSync = vi.mocked(readFileSync);
const mockedWriteFileSync = vi.mocked(writeFileSync);
const mockedOpenSync = vi.mocked(openSync);
const mockedFsyncSync = vi.mocked(fsyncSync);
const mockedRenameSync = vi.mocked(renameSync);
const mockedRmSync = vi.mocked(rmSync);
const mockedInstallPlugin = vi.mocked(installClaudePlugin);
const mockedUninstallPlugin = vi.mocked(uninstallClaudePlugin);
const mockedStatusPlugin = vi.mocked(statusClaudePlugin);

const SKILL_CONTENT = "---\nname: prim\n---\n\nbody\n";
const tmpFor = (target: string) => `${target}.${TMP_ID}.tmp`;

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
  mockedRandomUUID.mockReturnValue(TMP_ID);
  mockedExistsSync.mockReturnValue(false);
  mockedOpenSync.mockReturnValue(1);
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
// atomicWrite
// ---------------------------------------------------------------------------

describe("atomicWrite", () => {
  it("uses an exclusive per-write temporary path", () => {
    atomicWrite("/repo/CLAUDE.md", "next");

    expect(mockedRandomUUID).toHaveBeenCalledOnce();
    expect(mockedOpenSync).toHaveBeenCalledWith(tmpFor("/repo/CLAUDE.md"), "wx");
    expect(mockedWriteFileSync).toHaveBeenCalledWith(1, "next");
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor("/repo/CLAUDE.md"), "/repo/CLAUDE.md");
  });

  it("removes its temporary file when a later step fails", () => {
    mockedFsyncSync.mockImplementationOnce(() => {
      throw new Error("disk failure");
    });

    expect(() => atomicWrite("/repo/CLAUDE.md", "next")).toThrow("disk failure");
    expect(mockedRmSync).toHaveBeenCalledWith(tmpFor("/repo/CLAUDE.md"), { force: true });
    expect(mockedRenameSync).not.toHaveBeenCalled();
  });

  it("does not remove a pre-existing temporary path after an exclusive-create collision", () => {
    const collision = Object.assign(new Error("already exists"), { code: "EEXIST" });
    mockedOpenSync.mockImplementationOnce(() => {
      throw collision;
    });

    expect(() => atomicWrite("/repo/CLAUDE.md", "next")).toThrow(collision);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(mockedRmSync).not.toHaveBeenCalled();
    expect(mockedRenameSync).not.toHaveBeenCalled();
  });

  it("removes its owned temporary file when writing through the descriptor fails", () => {
    mockedWriteFileSync.mockImplementationOnce(() => {
      throw new Error("partial write");
    });

    expect(() => atomicWrite("/repo/CLAUDE.md", "next")).toThrow("partial write");
    expect(mockedRmSync).toHaveBeenCalledWith(tmpFor("/repo/CLAUDE.md"), { force: true });
    expect(mockedRenameSync).not.toHaveBeenCalled();
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
    const [, content] = mockedWriteFileSync.mock.calls[0];
    expect(mockedOpenSync).toHaveBeenCalledWith(tmpFor("/repo/CLAUDE.md"), "wx");
    expect(String(content)).toContain(SKILL_BEGIN);
    expect(String(content)).toContain(SKILL_END);
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor("/repo/CLAUDE.md"), "/repo/CLAUDE.md");
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
    expect(mockedOpenSync).toHaveBeenCalledWith(tmpFor("/repo/custom/rules.md"), "wx");
    expect(mockedRenameSync).toHaveBeenCalledWith(
      tmpFor("/repo/custom/rules.md"),
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
// --agent routing (agent → default rules file)
// ---------------------------------------------------------------------------

describe("runInstall --agent routing", () => {
  it("routes --agent hermes to .hermes.md, ignoring an existing CLAUDE.md", () => {
    // CLAUDE.md present on disk; --agent must still target .hermes.md and never
    // touch CLAUDE.md — the whole point of the hardening.
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("SKILL.md") || s === "/repo/CLAUDE.md";
    });
    mockedReadFileSync.mockImplementation((p) =>
      String(p).endsWith("SKILL.md") ? SKILL_CONTENT : "",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", { agent: "hermes" })).toBe(0);
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor("/repo/.hermes.md"), "/repo/.hermes.md");
    for (const [path] of mockedOpenSync.mock.calls) {
      expect(String(path)).not.toContain("CLAUDE.md");
    }
  });

  it("routes --agent codex to AGENTS.md even when CLAUDE.md is the file on disk", () => {
    // Discriminating: auto-detect would pick the lone CLAUDE.md, so a passing
    // assertion proves --agent overrode detection.
    mockedExistsSync.mockImplementation((p) => {
      const s = String(p);
      return s.endsWith("SKILL.md") || s === "/repo/CLAUDE.md";
    });
    mockedReadFileSync.mockImplementation((p) =>
      String(p).endsWith("SKILL.md") ? SKILL_CONTENT : "",
    );
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", { agent: "codex" })).toBe(0);
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor("/repo/AGENTS.md"), "/repo/AGENTS.md");
    for (const [path] of mockedOpenSync.mock.calls) {
      expect(String(path)).not.toContain("CLAUDE.md");
    }
  });

  it("routes --agent claude to the skills-dir plugin, never a rules-file write", () => {
    // Claude reads a skills-directory plugin, not CLAUDE.md — install must
    // delegate to the plugin module and write no rules file.
    mockedInstallPlugin.mockReturnValue(0);
    expect(runInstall("/repo", { agent: "claude" })).toBe(0);
    expect(mockedInstallPlugin).toHaveBeenCalledWith("/repo", { agent: "claude" });
    expect(mockedRenameSync).not.toHaveBeenCalled();
  });

  it("prefers an explicit --target over --agent", () => {
    fsFixture({ target: "/repo/custom.md", targetContent: "" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", { target: "custom.md", agent: "hermes" })).toBe(0);
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor("/repo/custom.md"), "/repo/custom.md");
  });

  it("aborts on an unknown --agent without writing (no CLAUDE.md fallthrough)", () => {
    fsFixture();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runInstall("/repo", { agent: "bogus" })).toBe(1);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown --agent"));
    errSpy.mockRestore();
  });

  it("aborts cleanly on an --agent that collides with an Object.prototype key", () => {
    // toString/constructor/__proto__ are truthy inherited members; the guard must
    // treat them as unknown agents — return 1, print the message, and NOT throw
    // (uninstall/status have no CLI try/catch, so a throw would dump a stack trace).
    fsFixture();
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    let code: number | undefined;
    expect(() => {
      code = runInstall("/repo", { agent: "toString" });
    }).not.toThrow();
    expect(code).toBe(1);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown --agent"));
    expect(() => runUninstall("/repo", { agent: "constructor" })).not.toThrow();
    expect(() => runStatus("/repo", { agent: "__proto__" })).not.toThrow();
    errSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// --scope user routing (agent → the machine-global rules file, cwd-independent)
// ---------------------------------------------------------------------------

describe("runInstall --scope user routing", () => {
  it("routes --scope user --agent claude to the plugin module, never a rules-file write", () => {
    mockedInstallPlugin.mockReturnValue(0);
    expect(runInstall("/repo", { agent: "claude", scope: "user" })).toBe(0);
    expect(mockedInstallPlugin).toHaveBeenCalledWith("/repo", { agent: "claude", scope: "user" });
    expect(mockedRenameSync).not.toHaveBeenCalled();
  });

  it("routes --scope user --agent codex to ~/.codex/AGENTS.md", () => {
    fsFixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", { agent: "codex", scope: "user" })).toBe(0);
    const target = join(homedir(), ".codex", "AGENTS.md");
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor(target), target);
  });

  it("routes --scope user --agent hermes to the hermes home .hermes.md", () => {
    fsFixture();
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", { agent: "hermes", scope: "user" })).toBe(0);
    const target = join(process.env.HERMES_HOME ?? join(homedir(), ".hermes"), ".hermes.md");
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor(target), target);
  });

  it("aborts --scope user without --agent (can't pick a global rules file)", () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runInstall("/repo", { scope: "user" })).toBe(1);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  it("still prefers an explicit --target over --scope user", () => {
    fsFixture({ target: "/repo/custom.md", targetContent: "" });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runInstall("/repo", { target: "custom.md", agent: "claude", scope: "user" })).toBe(0);
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor("/repo/custom.md"), "/repo/custom.md");
  });

  it("aborts on an unknown --scope without writing", () => {
    // No --agent → the file-block path validates scope in resolveTarget. (The
    // claude plugin path validates scope in claude-plugin.spec.ts.)
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(runInstall("/repo", { scope: "bogus" })).toBe(1);
    expect(mockedWriteFileSync).not.toHaveBeenCalled();
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown --scope"));
    errSpy.mockRestore();
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
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor("/repo/CLAUDE.md"), "/repo/CLAUDE.md");
  });

  it("routes --agent claude to the plugin module, never a rules-file write", () => {
    mockedUninstallPlugin.mockReturnValue(0);
    expect(runUninstall("/repo", { agent: "claude" })).toBe(0);
    expect(mockedUninstallPlugin).toHaveBeenCalledWith("/repo", { agent: "claude" });
    expect(mockedRenameSync).not.toHaveBeenCalled();
  });

  it("routes --agent claude WITH --target to the file-block path, not the plugin", () => {
    const existing = `# x\n${SKILL_BEGIN}\nbody\n${SKILL_END}\n`;
    fsFixture({ target: "/repo/custom.md", targetContent: existing });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runUninstall("/repo", { agent: "claude", target: "custom.md" })).toBe(0);
    expect(mockedUninstallPlugin).not.toHaveBeenCalled();
    expect(mockedRenameSync).toHaveBeenCalledWith(tmpFor("/repo/custom.md"), "/repo/custom.md");
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

  it("emits {installed, target} JSON under --json (installed case)", () => {
    const existing = `${SKILL_BEGIN}\nbody\n${SKILL_END}\n`;
    fsFixture({ target: "/repo/CLAUDE.md", targetContent: existing });
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runStatus("/repo", { json: true })).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
      installed: true,
      target: "/repo/CLAUDE.md",
    });
    logSpy.mockRestore();
  });

  it("routes --agent claude to the plugin module", () => {
    mockedStatusPlugin.mockReturnValue(0);
    expect(runStatus("/repo", { agent: "claude", json: true })).toBe(0);
    expect(mockedStatusPlugin).toHaveBeenCalledWith("/repo", { agent: "claude", json: true });
  });

  it("routes --agent claude WITH --target to the file-block path, not the plugin", () => {
    const existing = `${SKILL_BEGIN}\nbody\n${SKILL_END}\n`;
    fsFixture({ target: "/repo/custom.md", targetContent: existing });
    vi.spyOn(console, "log").mockImplementation(() => {});
    expect(runStatus("/repo", { agent: "claude", target: "custom.md" })).toBe(0);
    expect(mockedStatusPlugin).not.toHaveBeenCalled();
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});
