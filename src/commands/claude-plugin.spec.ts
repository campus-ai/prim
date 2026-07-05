import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitToplevel } from "../lib/git.js";
import {
  installClaudePlugin,
  resolvePluginDir,
  statusClaudePlugin,
  uninstallClaudePlugin,
} from "./claude-plugin.js";
import { loadSkill } from "./skill.js";

// homedir → the test's temp dir so "user scope" is sandboxed; gitToplevel is
// controlled so project-scope resolution is deterministic regardless of where
// the suite runs. Real fs otherwise.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
vi.mock("../lib/git.js", () => ({ gitToplevel: vi.fn(() => null) }));

const mockedHomedir = vi.mocked(homedir);
const mockedGitToplevel = vi.mocked(gitToplevel);

let work: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "prim-plugin-"));
  mockedHomedir.mockReturnValue(work);
  mockedGitToplevel.mockReturnValue(null);
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const userDir = () => join(work, ".claude", "skills", "prim");

describe("resolvePluginDir", () => {
  it("maps user scope to ~/.claude/skills/prim", () => {
    expect(resolvePluginDir(work, "user")).toBe(join(work, ".claude", "skills", "prim"));
  });

  it("anchors project scope at the git root", () => {
    mockedGitToplevel.mockReturnValue("/some/root");
    expect(resolvePluginDir(work, "project")).toBe(join("/some/root", ".claude", "skills", "prim"));
  });

  it("falls back to cwd for project scope outside a repo", () => {
    mockedGitToplevel.mockReturnValue(null);
    expect(resolvePluginDir("/here", "project")).toBe(join("/here", ".claude", "skills", "prim"));
  });

  it("returns null on an unknown scope", () => {
    expect(resolvePluginDir(work, "bogus")).toBe(null);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown --scope"));
  });
});

describe("installClaudePlugin", () => {
  it("writes the manifest and SKILL.md at the user skills dir", () => {
    expect(installClaudePlugin(work, { scope: "user" })).toBe(0);
    const dir = userDir();
    const manifest = JSON.parse(readFileSync(join(dir, ".claude-plugin", "plugin.json"), "utf-8"));
    expect(manifest.name).toBe("prim");
    expect(typeof manifest.version).toBe("string");
    expect(manifest.description).toContain("prim");
    expect(readFileSync(join(dir, "SKILL.md"), "utf-8")).toBe(loadSkill());
  });

  it("anchors project scope at the git root, ignoring homedir and cwd", () => {
    const root = mkdtempSync(join(tmpdir(), "prim-root-"));
    mockedGitToplevel.mockReturnValue(root);
    mockedHomedir.mockReturnValue(join(work, "HOME_SHOULD_BE_IGNORED"));
    try {
      expect(installClaudePlugin(join(root, "sub", "dir"), {})).toBe(0);
      expect(existsSync(join(root, ".claude", "skills", "prim", "SKILL.md"))).toBe(true);
      expect(existsSync(join(work, "HOME_SHOULD_BE_IGNORED", ".claude"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("is a byte-stable no-op on re-run", () => {
    expect(installClaudePlugin(work, { scope: "user" })).toBe(0);
    const dir = userDir();
    const manifest = readFileSync(join(dir, ".claude-plugin", "plugin.json"));
    const skill = readFileSync(join(dir, "SKILL.md"));
    logSpy.mockClear();
    expect(installClaudePlugin(work, { scope: "user" })).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No changes"));
    expect(readFileSync(join(dir, ".claude-plugin", "plugin.json")).equals(manifest)).toBe(true);
    expect(readFileSync(join(dir, "SKILL.md")).equals(skill)).toBe(true);
  });

  it("writes nothing under --dry-run", () => {
    expect(installClaudePlugin(work, { scope: "user", dryRun: true })).toBe(0);
    expect(existsSync(userDir())).toBe(false);
  });

  it("aborts on an unknown --scope without writing", () => {
    expect(installClaudePlugin(work, { scope: "bogus" })).toBe(1);
    expect(existsSync(join(work, ".claude"))).toBe(false);
    expect(errSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown --scope"));
  });
});

describe("uninstallClaudePlugin", () => {
  it("removes the plugin dir", () => {
    installClaudePlugin(work, { scope: "user" });
    expect(existsSync(userDir())).toBe(true);
    expect(uninstallClaudePlugin(work, { scope: "user" })).toBe(0);
    expect(existsSync(userDir())).toBe(false);
  });

  it("is a safe no-op when absent", () => {
    expect(uninstallClaudePlugin(work, { scope: "user" })).toBe(0);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not present"));
  });

  it("leaves a stray skills/prim dir (no manifest/SKILL.md) intact", () => {
    const stray = join(userDir(), "user-file.txt");
    mkdirSync(userDir(), { recursive: true });
    writeFileSync(stray, "keep me");
    expect(uninstallClaudePlugin(work, { scope: "user" })).toBe(0);
    expect(existsSync(stray)).toBe(true);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("not present"));
  });

  it("removes only our files, preserving co-located user files", () => {
    installClaudePlugin(work, { scope: "user" });
    const note = join(userDir(), "user-note.txt");
    writeFileSync(note, "my notes");
    expect(uninstallClaudePlugin(work, { scope: "user" })).toBe(0);
    // Our managed files and scaffolding are gone…
    expect(existsSync(join(userDir(), "SKILL.md"))).toBe(false);
    expect(existsSync(join(userDir(), ".claude-plugin"))).toBe(false);
    // …but the user's file — and therefore the dir holding it — survives.
    expect(existsSync(note)).toBe(true);
  });
});

describe("statusClaudePlugin", () => {
  it("reports absent before install and installed after", () => {
    expect(statusClaudePlugin(work, { scope: "user" })).toBe(1);
    installClaudePlugin(work, { scope: "user" });
    expect(statusClaudePlugin(work, { scope: "user" })).toBe(0);
    uninstallClaudePlugin(work, { scope: "user" });
    expect(statusClaudePlugin(work, { scope: "user" })).toBe(1);
  });

  it("emits {installed, target} JSON under --json", () => {
    installClaudePlugin(work, { scope: "user" });
    logSpy.mockClear();
    expect(statusClaudePlugin(work, { scope: "user", json: true })).toBe(0);
    expect(JSON.parse(String(logSpy.mock.calls[0][0]))).toEqual({
      installed: true,
      target: userDir(),
    });
  });
});
