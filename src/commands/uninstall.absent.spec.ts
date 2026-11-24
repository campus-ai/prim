/**
 * Uninstalling an integration that was never installed: nothing to remove, so
 * nothing may be written. These tests run the real uninstall functions in a
 * fresh repository under a fresh HOME and read the disk afterwards.
 */
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const startDirectory = process.cwd();
let root: string;
let home: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "prim-uninstall-absent-")));
  home = join(root, "home");
  repo = join(root, "repo");
  mkdirSync(home);
  mkdirSync(repo);
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  vi.stubEnv("HOME", home);
  vi.stubEnv("PRIM_CONFIG_DIR", join(home, ".config", "prim"));
  vi.stubEnv("CODEX_HOME", join(home, ".codex"));
  vi.stubEnv("CURSOR_CONFIG_DIR", join(home, ".cursor"));
  vi.stubEnv("HERMES_HOME", join(home, ".hermes"));
  process.chdir(repo);
  // Claude's user-scope path is fixed when its module loads, so load it fresh.
  vi.resetModules();
});

afterEach(() => {
  process.chdir(startDirectory);
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});

type Scope = "project" | "user";
type Integration = {
  name: string;
  scope: Scope;
  file: () => string;
  uninstall: () => Promise<{ changed: boolean }>;
  installed: () => Promise<unknown>;
};

const base = (scope: Scope): string => (scope === "project" ? repo : home);

const integrations: Integration[] = (["project", "user"] as const).flatMap((scope) => [
  {
    name: "Claude Code",
    scope,
    file: () => join(base(scope), ".claude", "settings.json"),
    uninstall: async () => (await import("./claude-install.js")).performUninstall(scope),
    installed: async () => (await import("./claude-install.js")).applyInstall({}),
  },
  {
    name: "Codex",
    scope,
    file: () => join(base(scope), ".codex", "hooks.json"),
    uninstall: async () => (await import("./codex-install.js")).performUninstall(scope),
    installed: async () => (await import("./codex-install.js")).applyInstall({}),
  },
  {
    name: "Cursor",
    scope,
    file: () => join(base(scope), ".cursor", "hooks.json"),
    uninstall: async () => (await import("./cursor-install.js")).performUninstall(scope),
    installed: async () => (await import("./cursor-install.js")).applyCursorInstall({}, scope),
  },
]);

describe("uninstalling an integration that is not installed", () => {
  it.each(integrations)(
    "$name $scope scope creates no file and no directory",
    async ({ uninstall }) => {
      const result = await uninstall();

      expect(result.changed).toBe(false);
      expect(readdirSync(repo)).toEqual([".git"]);
      expect(readdirSync(home)).toEqual([]);
    },
  );

  it.each(integrations)(
    "$name $scope scope leaves a file holding nothing of prim's untouched",
    async ({ file, uninstall }) => {
      // Compact and unterminated, so any rewrite changes the bytes.
      const foreign = '{"custom":true}';
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), foreign);

      const result = await uninstall();

      expect(result.changed).toBe(false);
      expect(readFileSync(file(), "utf8")).toBe(foreign);
    },
  );

  it.each(integrations)(
    "$name $scope scope still empties a file holding only prim's entries",
    async ({ file, uninstall, installed }) => {
      mkdirSync(dirname(file()), { recursive: true });
      writeFileSync(file(), JSON.stringify(await installed()));

      const result = await uninstall();

      expect(result.changed).toBe(true);
      expect(JSON.parse(readFileSync(file(), "utf8")).hooks).toEqual({});
    },
  );
});

describe("prim uninstall where nothing is installed", () => {
  it("leaves a clean checkout and an empty home exactly as it found them", async () => {
    const { registerUninstallCommand } = await import("./uninstall.js");
    const claude = await import("./claude-install.js");
    const codex = await import("./codex-install.js");
    const cursor = await import("./cursor-install.js");
    const hermes = await import("./hermes-install.js");
    // The agent steps run for real, in process; the daemon and Git-hook steps
    // act on the machine rather than on HOME, so they are answered here.
    const run = (args: string[]): { code: number; stdout: string; stderr: string } => {
      const scope = args.at(-1) as Scope;
      let result: unknown = "";
      if (args[0] === "daemon") {
        result = { stopped: false, wasRunning: false, absent: true, verified: true };
      } else if (args[0] === "claude") result = claude.performUninstall(scope);
      else if (args[0] === "codex") result = codex.performUninstall(scope);
      else if (args[0] === "cursor") result = cursor.performUninstall(scope);
      else if (args[0] === "hermes") result = hermes.performUninstall();
      return { code: 0, stdout: JSON.stringify(result), stderr: "" };
    };
    const write = vi.fn();
    const exit = vi.fn();
    const program = new Command();
    registerUninstallCommand(program, {
      inRepository: () => true,
      run,
      removeRuntimes: async () => ({
        status: "removed",
        hookRuntimeChanged: false,
        daemonRuntimeChanged: false,
      }),
      note: vi.fn(),
      write,
      exit,
    });

    await program.parseAsync(["uninstall"], { from: "user" });

    expect(JSON.parse(String(write.mock.calls[0][0]))).toMatchObject({
      uninstalled: true,
      projectScopeChecked: true,
    });
    expect(exit).toHaveBeenCalledWith(0);
    expect(readdirSync(repo)).toEqual([".git"]);
    expect(readdirSync(home)).toEqual([]);
  });
});
