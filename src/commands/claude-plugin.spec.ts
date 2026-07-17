import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { gitToplevel } from "../lib/git.js";
import {
  installClaudePlugin,
  refreshClaudePlugins,
  resolvePluginDir,
  statusClaudePlugin,
  uninstallClaudePlugin,
} from "./claude-plugin.js";
import { atomicWrite, loadSkill } from "./skill.js";

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

describe("refreshClaudePlugins", () => {
  const manifestPath = (dir: string) => join(dir, ".claude-plugin", "plugin.json");
  const skillPath = (dir: string) => join(dir, "SKILL.md");

  it("leaves current recognized installs untouched", () => {
    installClaudePlugin(work, { scope: "user" });
    const manifest = readFileSync(manifestPath(userDir()));
    const skill = readFileSync(skillPath(userDir()));

    expect(refreshClaudePlugins(work)).toEqual({ installed: 1, refreshed: 0 });
    expect(readFileSync(manifestPath(userDir())).equals(manifest)).toBe(true);
    expect(readFileSync(skillPath(userDir())).equals(skill)).toBe(true);
  });

  it.each(["user", "project"] as const)("refreshes a stale %s-scope install", (scope) => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(root, { scope });
    const dir = scope === "user" ? userDir() : join(root, ".claude", "skills", "prim");
    writeFileSync(skillPath(dir), `stale ${scope} skill\n`);

    expect(refreshClaudePlugins(root)).toEqual({ installed: 1, refreshed: 1 });
    expect(readFileSync(skillPath(dir), "utf-8")).toBe(loadSkill());
  });

  it("refreshes stale user and project installs in the same pass", () => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(work, { scope: "user" });
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    writeFileSync(manifestPath(userDir()), '{"name":"prim","version":"old"}\n');
    writeFileSync(skillPath(userDir()), "stale user skill\n");
    writeFileSync(manifestPath(projectDir), '{"name":"prim","version":"old"}\n');
    writeFileSync(skillPath(projectDir), "stale project skill\n");

    expect(refreshClaudePlugins(root)).toEqual({ installed: 2, refreshed: 2 });
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe(loadSkill());
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe(loadSkill());
    expect(JSON.parse(readFileSync(manifestPath(userDir()), "utf-8"))).toMatchObject({
      name: "prim",
      version: expect.not.stringMatching("old"),
    });
    expect(JSON.parse(readFileSync(manifestPath(projectDir), "utf-8"))).toMatchObject({
      name: "prim",
      version: expect.not.stringMatching("old"),
    });
  });

  it("does not create missing installs", () => {
    expect(refreshClaudePlugins(work)).toEqual({ installed: 0, refreshed: 0 });
    expect(existsSync(userDir())).toBe(false);
    expect(existsSync(join(work, ".claude", "skills", "prim"))).toBe(false);
  });

  it("leaves malformed, partial, and non-Prim plugins untouched", () => {
    const cases = [
      { name: "malformed", manifest: "not json", skill: "custom skill" },
      { name: "partial", manifest: '{"name":"prim"}', skill: undefined },
      { name: "unrelated", manifest: '{"name":"other"}', skill: "other skill" },
    ];

    for (const fixture of cases) {
      const root = join(work, fixture.name);
      const dir = join(root, ".claude", "skills", "prim");
      mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
      writeFileSync(manifestPath(dir), fixture.manifest);
      if (fixture.skill !== undefined) writeFileSync(skillPath(dir), fixture.skill);
      mockedGitToplevel.mockReturnValue(root);

      expect(refreshClaudePlugins(root)).toEqual({ installed: 0, refreshed: 0 });
      expect(readFileSync(manifestPath(dir), "utf-8")).toBe(fixture.manifest);
      if (fixture.skill !== undefined) {
        expect(readFileSync(skillPath(dir), "utf-8")).toBe(fixture.skill);
      } else {
        expect(existsSync(skillPath(dir))).toBe(false);
      }
    }
  });

  it("continues refreshing the project scope when the user scope write fails", () => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(work, { scope: "user" });
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    writeFileSync(skillPath(userDir()), "stale user skill\n");
    writeFileSync(skillPath(projectDir), "stale project skill\n");

    expect(
      refreshClaudePlugins(root, {
        writeFile: (target, content) => {
          if (target.startsWith(userDir())) throw new Error("user scope is read-only");
          atomicWrite(target, content);
        },
      }),
    ).toEqual({ installed: 2, refreshed: 1 });
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe("stale user skill\n");
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe(loadSkill());
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
