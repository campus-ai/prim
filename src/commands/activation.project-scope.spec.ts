/**
 * `prim enable|disable --scope project` against real repositories: the
 * committed opt-out is a file a fresh clone carries, so these tests write it,
 * commit it, clone it, and ask the capture gate.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/git-hooks.js", () => ({
  MANAGED_GIT_HOOK_NAMES: ["pre-commit", "post-commit", "post-rewrite"],
  ensureEffectiveGitHook: vi.fn((hookName: string) => ({
    hookName,
    path: `/hooks/${hookName}`,
    changed: false,
    kind: "direct",
    outcome: "unchanged",
  })),
  externalHookRemedy: vi.fn(() => ""),
}));
vi.mock("../lib/repository-binding.js", () => ({
  bindRepository: vi.fn(async () => ({
    status: "connected",
    repoSyncId: "repoSync123",
    repositoryFullName: "campus-ai/prim",
  })),
}));
vi.mock("../lib/commit-heartbeat.js", () => ({
  clearHooksWired: vi.fn(),
  recordHooksWired: vi.fn(),
}));
vi.mock("../lib/collect-scope.js", () => ({ fetchAndCacheCollectScope: vi.fn() }));
vi.mock("../daemon/client.js", () => ({ daemonRequest: vi.fn(async () => null) }));
vi.mock("./hooks.js", () => ({ refreshOwnedGlobalHooks: vi.fn(), stageGitHookRuntime: vi.fn() }));
vi.mock("./github.js", () => ({ runGithubConnect: vi.fn() }));

import {
  declaresInactive,
  explicitlyActive,
  isRepoActiveForCapture,
  markActivationImplicit,
  repoActiveFlag,
} from "../lib/activation.js";
import { ensureEffectiveGitHook } from "../lib/git-hooks.js";
import { bindRepository } from "../lib/repository-binding.js";
import { registerActivationCommands } from "./activation.js";

const dirs: string[] = [];
const startDirectory = process.cwd();
let printed: Array<Record<string, unknown>>;
let stderr: string;

function tempDir(prefix: string): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
  dirs.push(dir);
  return dir;
}

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
  });

function repo(settings?: unknown): string {
  const root = tempDir("prim-scope-");
  git(root, "init", "--quiet");
  if (settings !== undefined) {
    mkdirSync(join(root, ".claude"));
    writeFileSync(
      join(root, ".claude", "settings.json"),
      typeof settings === "string" ? settings : JSON.stringify(settings),
    );
  }
  return root;
}

const settingsPath = (root: string) => join(root, ".claude", "settings.json");
const readSettingsFile = (root: string) =>
  JSON.parse(readFileSync(settingsPath(root), "utf8")) as Record<string, unknown>;

async function run(root: string, ...args: string[]): Promise<void> {
  process.chdir(root);
  const program = new Command();
  program.exitOverride();
  program.option("-y, --yes").option("--non-interactive");
  registerActivationCommands(program);
  await program.parseAsync(args, { from: "user" });
}

function preparedCloudSession(): void {
  const configDir = tempDir("prim-scope-config-");
  writeFileSync(join(configDir, "cloud-prepared"), "1\n");
  vi.stubEnv("PRIM_CONFIG_DIR", configDir);
  vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
}

beforeEach(() => {
  vi.clearAllMocks();
  printed = [];
  stderr = "";
  vi.stubEnv("GIT_CONFIG_GLOBAL", "/dev/null");
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.spyOn(console, "log").mockImplementation((value: string) => {
    printed.push(JSON.parse(value) as Record<string, unknown>);
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk) => {
    stderr += String(chunk);
    return true;
  });
  vi.spyOn(process, "exit").mockImplementation((code) => {
    throw new Error(`exit ${code}`);
  });
});

afterEach(() => {
  process.chdir(startDirectory);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.exitCode = undefined;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("prim disable --scope project", () => {
  it("records the opt-out beside existing settings and mutes this clone", async () => {
    const root = repo({ env: { FOO: "1" }, permissions: { allow: ["Bash(ls:*)"] } });
    await run(root, "disable", "--scope", "project");

    expect(readSettingsFile(root)).toEqual({
      env: { FOO: "1", PRIM_ACTIVE: "false" },
      permissions: { allow: ["Bash(ls:*)"] },
    });
    expect(repoActiveFlag(root)).toBe("false");
    expect(printed[0]).toMatchObject({
      active: false,
      repo: root,
      declaredInactive: true,
      settingsPath: settingsPath(root),
    });
    expect(stderr).toContain("commit it");
  });

  it("creates the settings file where the repository has none", async () => {
    const root = repo();
    await run(root, "disable", "--scope", "project");
    expect(readSettingsFile(root)).toEqual({ env: { PRIM_ACTIVE: "false" } });
  });

  it("holds in a fresh clone opened by a prepared Claude Code cloud environment", async () => {
    const root = repo();
    await run(root, "disable", "--scope", "project");
    git(root, "add", ".claude/settings.json");
    git(root, "commit", "--quiet", "-m", "chore: keep prim off here");

    const clone = join(tempDir("prim-scope-clone-"), "clone");
    git(root, "clone", "--quiet", root, clone);
    preparedCloudSession();
    // The per-clone flag did not travel; the committed declaration did.
    expect(repoActiveFlag(clone)).toBeUndefined();
    expect(isRepoActiveForCapture(clone)).toBe(false);
    // The same environment still activates a repository that says nothing.
    expect(isRepoActiveForCapture(repo())).toBe(true);
  });

  it("changes nothing the second time", async () => {
    const root = repo();
    await run(root, "disable", "--scope", "project");
    const before = readFileSync(settingsPath(root), "utf8");
    await run(root, "disable", "--scope", "project");
    expect(readFileSync(settingsPath(root), "utf8")).toBe(before);
    expect(printed[1]).toMatchObject({ active: false, declaredInactive: true });
    expect(printed[1]).not.toHaveProperty("settingsPath");
  });

  it("fails before muting anything when the settings file is not valid JSON", async () => {
    const root = repo("{ not json");
    await expect(run(root, "disable", "--scope", "project")).rejects.toThrow("exit 1");
    expect(readFileSync(settingsPath(root), "utf8")).toBe("{ not json");
    expect(repoActiveFlag(root)).toBeUndefined();
    expect(stderr).toContain("is not valid JSON");
    expect(printed).toEqual([]);
  });

  it("refuses a settings path prim would not read the opt-out back from", async () => {
    // Prim reads a declaration only from a real .claude directory; writing
    // through a symbolic link would report an opt-out that holds nowhere.
    const root = repo();
    mkdirSync(join(root, ".agents"));
    symlinkSync(join(root, ".agents"), join(root, ".claude"));
    await expect(run(root, "disable", "--scope", "project")).rejects.toThrow("exit 1");
    expect(existsSync(join(root, ".agents", "settings.json"))).toBe(false);
    expect(repoActiveFlag(root)).toBeUndefined();
    expect(stderr).toContain("not a symbolic link");
    expect(printed).toEqual([]);
  });

  it("rejects any other scope without touching the repository", async () => {
    const root = repo();
    await expect(run(root, "disable", "--scope", "user")).rejects.toThrow("exit 2");
    expect(existsSync(settingsPath(root))).toBe(false);
    expect(repoActiveFlag(root)).toBeUndefined();
    expect(stderr).toContain("accepts only 'project'");
  });
});

describe("prim enable --scope project", () => {
  it("removes the opt-out, drops an emptied env, and enables this clone", async () => {
    const root = repo({ env: { PRIM_ACTIVE: "false" }, permissions: {} });
    await run(root, "enable", "--scope", "project");
    expect(readSettingsFile(root)).toEqual({ permissions: {} });
    expect(repoActiveFlag(root)).toBe("true");
    expect(printed[0]).toMatchObject({
      active: true,
      declaredInactive: false,
      settingsPath: settingsPath(root),
    });
    expect(stderr).toContain("removed this repository's opt-out");
  });

  it("fails on an unreadable settings file before wiring hooks or binding", async () => {
    const root = repo("{ not json");
    await expect(run(root, "enable", "--scope", "project")).rejects.toThrow("exit 1");
    expect(ensureEffectiveGitHook).not.toHaveBeenCalled();
    expect(bindRepository).not.toHaveBeenCalled();
    expect(repoActiveFlag(root)).toBeUndefined();
    expect(stderr).toContain("is not valid JSON");
  });

  it("keeps the opt-out, and says so, when the repository is not connected", async () => {
    vi.mocked(bindRepository).mockResolvedValueOnce({
      status: "unbound",
      repositoryFullName: "campus-ai/prim",
    });
    const root = repo({ env: { PRIM_ACTIVE: "false" } });
    const before = readFileSync(settingsPath(root), "utf8");
    await run(root, "--non-interactive", "enable", "--scope", "project");
    expect(readFileSync(settingsPath(root), "utf8")).toBe(before);
    expect(printed[0]).toMatchObject({ active: false, declaredInactive: true });
    expect(process.exitCode).toBe(1);
  });

  it("leaves a settings file without the opt-out byte for byte", async () => {
    const root = repo({ env: { PRIM_REPOSITORY: "campus-ai/prim" } });
    const before = readFileSync(settingsPath(root), "utf8");
    await run(root, "enable", "--scope", "project");
    expect(readFileSync(settingsPath(root), "utf8")).toBe(before);
    expect(printed[0]).not.toHaveProperty("settingsPath");
  });
});

describe("plain prim enable / disable beside the committed opt-out", () => {
  it("enable turns on this clone only and says the repository still opts out", async () => {
    const root = repo({ env: { PRIM_ACTIVE: "false" } });
    const before = readFileSync(settingsPath(root), "utf8");
    await run(root, "enable");
    expect(readFileSync(settingsPath(root), "utf8")).toBe(before);
    expect(declaresInactive(root)).toBe(true);
    expect(isRepoActiveForCapture(root)).toBe(true);
    expect(printed[0]).toMatchObject({ active: true, declaredInactive: true });
    expect(stderr).toContain("enabled for this clone only");
  });

  it("enable makes a flag prim wrote for an implicit opt-in the user's own", async () => {
    const root = repo({ env: { PRIM_ACTIVE: "false" } });
    git(root, "config", "--local", "prim.active", "true");
    markActivationImplicit(root);
    expect(explicitlyActive(root)).toBe(false);
    await run(root, "enable");
    expect(explicitlyActive(root)).toBe(true);
  });

  it("disable in a prepared cloud session says it will not outlive the session", async () => {
    preparedCloudSession();
    const root = repo();
    await run(root, "disable");
    expect(existsSync(settingsPath(root))).toBe(false);
    expect(printed[0]).toMatchObject({ active: false, declaredInactive: false });
    expect(stderr).toContain("prim disable --scope project");
  });

  it("disable elsewhere, or where the opt-out is already committed, adds no hint", async () => {
    await run(repo(), "disable");
    expect(stderr).not.toContain("--scope project");

    stderr = "";
    preparedCloudSession();
    await run(repo({ env: { PRIM_ACTIVE: "false" } }), "disable");
    expect(stderr).not.toContain("--scope project");
  });
});
