import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fileLockExists, withFileLock } from "../lib/file-lock.js";
import { gitToplevel } from "../lib/git.js";
import {
  compareSemver,
  installClaudePlugin,
  pluginPaths,
  refreshClaudePlugins,
  resolvePluginDir,
  statusClaudePlugin,
  uninstallClaudePlugin,
} from "./claude-plugin.js";
import { atomicWrite, loadSkill } from "./skill.js";

// homedir → the test's temp dir so "user scope" is sandboxed; gitToplevel is
// controlled so project-scope resolution is deterministic regardless of where
// the suite runs. atomicWrite passes through to the real implementation but is
// a mock so refresh tests can inject a single write failure. Real fs otherwise.
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: vi.fn(() => actual.homedir()) };
});
vi.mock("../lib/git.js", () => ({ gitToplevel: vi.fn(() => null) }));
vi.mock("./skill.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./skill.js")>();
  return { ...actual, atomicWrite: vi.fn(actual.atomicWrite), loadSkill: vi.fn(actual.loadSkill) };
});

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
const usableSkill = (description: string) =>
  `---\nname: prim\ndescription: ${description}\n---\n\nSkill body\n`;

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
  const manifestPath = (dir: string) => pluginPaths(dir).manifestPath;
  const skillPath = (dir: string) => pluginPaths(dir).skillPath;

  it("leaves current recognized installs untouched", async () => {
    installClaudePlugin(work, { scope: "user" });
    const manifest = readFileSync(manifestPath(userDir()));
    const skill = readFileSync(skillPath(userDir()));

    await expect(refreshClaudePlugins(work)).resolves.toEqual({ installed: 1, refreshed: 0 });
    expect(readFileSync(manifestPath(userDir())).equals(manifest)).toBe(true);
    expect(readFileSync(skillPath(userDir())).equals(skill)).toBe(true);
  });

  it.each(["user", "project"] as const)("refreshes a stale %s-scope install", async (scope) => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(root, { scope });
    const dir = scope === "user" ? userDir() : join(root, ".claude", "skills", "prim");
    writeFileSync(skillPath(dir), `stale ${scope} skill\n`);

    await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 1, refreshed: 1 });
    expect(readFileSync(skillPath(dir), "utf-8")).toBe(loadSkill());
  });

  it("refreshes stale user and project installs in the same pass", async () => {
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

    await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 2, refreshed: 2 });
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

  it("can exclude project scope while still refreshing the user install", async () => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(work, { scope: "user" });
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    writeFileSync(skillPath(userDir()), "stale user skill\n");
    writeFileSync(skillPath(projectDir), "stale project skill\n");

    await expect(refreshClaudePlugins(root, { includeProject: false })).resolves.toEqual({
      installed: 1,
      refreshed: 1,
    });
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe(loadSkill());
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe("stale project skill\n");
  });

  it("does not downgrade a newer usable project-scope install", async () => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    const newerManifest = '{"name":"prim","version":"999.0.0"}\n';
    writeFileSync(manifestPath(projectDir), newerManifest);
    const newerSkill = usableSkill("newer project skill");
    writeFileSync(skillPath(projectDir), newerSkill);

    await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 1, refreshed: 0 });
    expect(readFileSync(manifestPath(projectDir), "utf-8")).toBe(newerManifest);
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe(newerSkill);
  });

  it("repairs an unusable project skill even when its manifest claims a newer version", async () => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    const currentVersion = JSON.parse(readFileSync(manifestPath(projectDir), "utf-8")).version;
    writeFileSync(manifestPath(projectDir), '{"name":"prim","version":"999.0.0"}\n');
    writeFileSync(skillPath(projectDir), "not usable frontmatter\n");

    await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 1, refreshed: 1 });
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe(loadSkill());
    expect(JSON.parse(readFileSync(manifestPath(projectDir), "utf-8"))).toMatchObject({
      name: "prim",
      version: currentVersion,
    });
  });

  it("repairs a newer project skill whose frontmatter has no usable body", async () => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    writeFileSync(manifestPath(projectDir), '{"name":"prim","version":"999.0.0"}\n');
    writeFileSync(skillPath(projectDir), "---\nname: prim\ndescription: header only\n---\n\n");

    await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 1, refreshed: 1 });
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe(loadSkill());
  });

  it.each([
    ["1.0.0", "1.0.0-alpha", 1],
    ["1.0.0-alpha.10", "1.0.0-alpha.2", 1],
    ["1.0.0-alpha.beta", "1.0.0-alpha.50", 1],
    ["1.0.0-alpha", "1.0.0-alpha.1", -1],
    ["1.0.0+build.2", "1.0.0+build.1", 0],
    ["1.0.0-alpha.01", "1.0.0-alpha.1", undefined],
    ["1.0", "1.0.0", undefined],
  ])("compares SemVer %s against %s", (left, right, precedence) => {
    expect(compareSemver(left, right)).toBe(precedence);
  });

  it("re-reads a project version after acquiring the cross-process lock", async () => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    const physicalDir = realpathSync(projectDir);
    const cacheRoot = process.env.XDG_CACHE_HOME || join(work, ".cache");
    const lockDir = join(
      cacheRoot,
      "prim",
      "skill-refresh-locks",
      `${createHash("sha256").update(physicalDir).digest("hex")}.lock`,
    );
    let releaseOwner!: () => void;
    const held = new Promise<void>((resolve) => {
      releaseOwner = resolve;
    });
    const owner = withFileLock(lockDir, () => held);
    while (!fileLockExists(lockDir)) await new Promise((resolve) => setTimeout(resolve, 1));

    const refreshing = refreshClaudePlugins(root);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const newerManifest = '{"name":"prim","version":"999.0.0"}\n';
    const newerSkill = usableSkill("newer version installed while waiting");
    writeFileSync(manifestPath(projectDir), newerManifest);
    writeFileSync(skillPath(projectDir), newerSkill);
    releaseOwner();
    await owner;

    await expect(refreshing).resolves.toEqual({ installed: 1, refreshed: 0 });
    expect(readFileSync(manifestPath(projectDir), "utf-8")).toBe(newerManifest);
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe(newerSkill);
  });

  it("deduplicates a physical user/project alias with project version semantics", async () => {
    mockedGitToplevel.mockReturnValue(work);
    installClaudePlugin(work, { scope: "user" });
    const newerManifest = '{"name":"prim","version":"999.0.0"}\n';
    const newerSkill = usableSkill("newer shared install");
    writeFileSync(manifestPath(userDir()), newerManifest);
    writeFileSync(skillPath(userDir()), newerSkill);

    await expect(refreshClaudePlugins(work)).resolves.toEqual({ installed: 1, refreshed: 0 });
    expect(readFileSync(manifestPath(userDir()), "utf-8")).toBe(newerManifest);
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe(newerSkill);
  });

  it("never treats a non-repository cwd as an automatic project candidate", async () => {
    const outside = join(work, "outside");
    mkdirSync(outside, { recursive: true });
    mockedGitToplevel.mockReturnValue(null);
    installClaudePlugin(outside, { scope: "project" });
    const projectDir = join(outside, ".claude", "skills", "prim");
    writeFileSync(skillPath(projectDir), "stale project skill\n");

    await expect(refreshClaudePlugins(outside)).resolves.toEqual({ installed: 0, refreshed: 0 });
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe("stale project skill\n");
  });

  it("does not create missing installs", async () => {
    await expect(refreshClaudePlugins(work)).resolves.toEqual({ installed: 0, refreshed: 0 });
    expect(existsSync(userDir())).toBe(false);
    expect(existsSync(join(work, ".claude", "skills", "prim"))).toBe(false);
  });

  it("leaves malformed, partial, and non-Prim plugins untouched", async () => {
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

      await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 0, refreshed: 0 });
      expect(readFileSync(manifestPath(dir), "utf-8")).toBe(fixture.manifest);
      if (fixture.skill !== undefined) {
        expect(readFileSync(skillPath(dir), "utf-8")).toBe(fixture.skill);
      } else {
        expect(existsSync(skillPath(dir))).toBe(false);
      }
    }
  });

  it("rejects a symlinked managed file without replacing it", async () => {
    const root = join(work, "repo");
    const external = join(work, "external-skill.md");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    writeFileSync(external, "external skill\n");
    rmSync(skillPath(projectDir));
    symlinkSync(external, skillPath(projectDir));

    await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 0, refreshed: 0 });
    expect(readFileSync(external, "utf-8")).toBe("external skill\n");
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe("external skill\n");
  });

  it("rejects project files redirected outside the repository by a parent symlink", async () => {
    const root = join(work, "repo");
    const externalClaude = join(work, "external-claude");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(root, { scope: "project" });
    renameSync(join(root, ".claude"), externalClaude);
    symlinkSync(externalClaude, join(root, ".claude"), "dir");
    const externalDir = join(externalClaude, "skills", "prim");
    writeFileSync(skillPath(externalDir), "redirected stale skill\n");

    await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 0, refreshed: 0 });
    expect(readFileSync(skillPath(externalDir), "utf-8")).toBe("redirected stale skill\n");
  });

  it("retains a usable installed scope when packaged skill rendering fails", async () => {
    installClaudePlugin(work, { scope: "user" });
    const staleSkill = usableSkill("usable stale user skill");
    writeFileSync(skillPath(userDir()), staleSkill);
    vi.mocked(atomicWrite).mockClear();
    vi.mocked(loadSkill).mockImplementationOnce(() => {
      throw new Error("packaged SKILL.md missing");
    });

    await expect(refreshClaudePlugins(work, { includeProject: false })).resolves.toEqual({
      installed: 1,
      refreshed: 0,
    });
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe(staleSkill);
  });

  it("continues refreshing the project scope when the user scope write fails", async () => {
    const root = join(work, "repo");
    mkdirSync(root, { recursive: true });
    mockedGitToplevel.mockReturnValue(root);
    installClaudePlugin(work, { scope: "user" });
    installClaudePlugin(root, { scope: "project" });
    const projectDir = join(root, ".claude", "skills", "prim");
    const staleUserSkill = usableSkill("usable stale user skill");
    writeFileSync(skillPath(userDir()), staleUserSkill);
    writeFileSync(skillPath(projectDir), "stale project skill\n");

    const userSkillPath = skillPath(userDir());
    vi.mocked(atomicWrite).mockImplementation((target, content) => {
      if (target === userSkillPath) throw new Error("user scope is read-only");
      writeFileSync(target, content);
    });

    await expect(refreshClaudePlugins(root)).resolves.toEqual({ installed: 2, refreshed: 1 });
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe(staleUserSkill);
    expect(readFileSync(skillPath(projectDir), "utf-8")).toBe(loadSkill());
  });

  it("retains a usable installed scope when its only write fails", async () => {
    installClaudePlugin(work, { scope: "user" });
    const staleSkill = usableSkill("usable stale user skill");
    writeFileSync(skillPath(userDir()), staleSkill);
    vi.mocked(atomicWrite).mockImplementation(() => {
      throw new Error("user scope is read-only");
    });

    await expect(refreshClaudePlugins(work, { includeProject: false })).resolves.toEqual({
      installed: 1,
      refreshed: 0,
    });
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe(staleSkill);
  });

  it("does not retain usability when a failed writer removes the current skill", async () => {
    installClaudePlugin(work, { scope: "user" });
    writeFileSync(skillPath(userDir()), usableSkill("usable before the write attempt"));
    const userSkillPath = skillPath(userDir());
    vi.mocked(atomicWrite).mockImplementation((target) => {
      if (target === userSkillPath) rmSync(userSkillPath);
      throw new Error("writer invalidated the target");
    });

    await expect(refreshClaudePlugins(work, { includeProject: false })).resolves.toEqual({
      installed: 0,
      refreshed: 0,
    });
    expect(existsSync(userSkillPath)).toBe(false);
  });

  it("reports a landed manifest update when the following skill write fails", async () => {
    installClaudePlugin(work, { scope: "user" });
    writeFileSync(manifestPath(userDir()), '{"name":"prim","version":"old"}\n');
    writeFileSync(skillPath(userDir()), "stale user skill\n");
    const userSkillPath = skillPath(userDir());
    vi.mocked(atomicWrite).mockImplementation((target, content) => {
      if (target === userSkillPath) throw new Error("skill is read-only");
      writeFileSync(target, content);
    });

    await expect(refreshClaudePlugins(work, { includeProject: false })).resolves.toEqual({
      installed: 0,
      refreshed: 1,
    });
    expect(JSON.parse(readFileSync(manifestPath(userDir()), "utf-8"))).toMatchObject({
      name: "prim",
      version: expect.not.stringMatching("old"),
    });
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe("stale user skill\n");
  });

  it("rejects oversized managed files without reading or replacing them", async () => {
    installClaudePlugin(work, { scope: "user" });
    const oversized = "x".repeat(64 * 1_024 + 1);
    writeFileSync(manifestPath(userDir()), oversized);
    vi.mocked(atomicWrite).mockClear();

    await expect(refreshClaudePlugins(work, { includeProject: false })).resolves.toEqual({
      installed: 0,
      refreshed: 0,
    });
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(readFileSync(manifestPath(userDir()), "utf-8")).toBe(oversized);
  });

  it("rejects an oversized skill without replacing it", async () => {
    installClaudePlugin(work, { scope: "user" });
    const oversized = "x".repeat(1_024 * 1_024 + 1);
    writeFileSync(skillPath(userDir()), oversized);
    vi.mocked(atomicWrite).mockClear();

    await expect(refreshClaudePlugins(work, { includeProject: false })).resolves.toEqual({
      installed: 0,
      refreshed: 0,
    });
    expect(atomicWrite).not.toHaveBeenCalled();
    expect(readFileSync(skillPath(userDir()), "utf-8")).toBe(oversized);
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
