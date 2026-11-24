/**
 * The hook command text each installer writes, held against the bytes the
 * released CLI wrote. Those bytes sit in agent configuration and in committed
 * settings files, and the installers know their own entries by them, so a
 * change of text reads as a drifted install everywhere at once.
 *
 * Only a Claude Code project install writes anything else: the one file a
 * repository commits for people who may not have prim. These tests run the
 * real install functions in a fresh repository under a fresh HOME.
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Staging copies the built runtime; these tests are about the settings text.
vi.mock("../lib/hook-runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/hook-runtime.js")>()),
  stageHookRuntime: vi.fn(),
}));

const startDirectory = process.cwd();
let root: string;
let home: string;
let repo: string;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "prim-hook-text-")));
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

// Frozen, and deliberately not built from product code. `released` is the
// stable hook command as the released CLI writes it; GUARD is the one addition
// a Claude Code project install makes to it.
const GUARD = '[ -e "$prim_launcher" ] || [ -L "$prim_launcher" ] || exit 0; ';
const released = (bin: string, args = "", guard = ""): string =>
  `/bin/sh -c 'prim_legacy_reader='"'"'-p @primitive.ai/prim@stable prim-shim.sh ${bin} '"'"'; prim_absolute() { case "$1" in [/]* ) ;; *) return 1 ;; esac; case "$1" in [[:space:]]*|*[[:space:]]|*[/][/]*|*[/].[/]*|*[/]..[/]*|*[/].|*[/]..|?*[/]) return 1 ;; esac; }; prim_config=\${PRIM_CONFIG_DIR:-}; if ! prim_absolute "$prim_config"; then prim_config=\${XDG_CONFIG_HOME:-}; if prim_absolute "$prim_config"; then case "$prim_config" in /) prim_config=/prim ;; *) prim_config="$prim_config/prim" ;; esac; else prim_home=\${HOME:-}; prim_absolute "$prim_home" || exit 78; case "$prim_home" in /) prim_config=/.config/prim ;; *) prim_config="$prim_home/.config/prim" ;; esac; fi; fi; case "$prim_config" in /) prim_launcher=/prim-hook-launcher-v1 ;; *) prim_launcher="$prim_config/prim-hook-launcher-v1" ;; esac; ${guard}exec "$prim_launcher" "$@"' prim-hook-launcher-v1 ${bin}${args ? ` ${args}` : ""}`;
const detached = (inner: string): string =>
  `payload=$(cat); { trap '' HUP; printf '%s' "$payload" | { ${inner}; }; } </dev/null >/dev/null 2>&1 &`;
const deferred = (inner: string, bin: string): string =>
  `prim_project="$CLAUDE_PROJECT_DIR/.claude/settings.json"; [ -f "$prim_project" ] && [ "$(cd -- "$CLAUDE_PROJECT_DIR" 2>/dev/null && pwd -P)" != "$(cd -- "\${HOME:-/}" 2>/dev/null && pwd -P)" ] && grep -qsE -- "(^|[[:space:]\\"])${bin}([[:space:]\\"]|\\$)" "$prim_project" || { ${inner}${inner.endsWith("&") ? "" : ";"} }`;

/** The bin and arguments a stable hook command ends in, whatever wraps it. */
function tail(command: string): { bin: string; args: string } {
  const match = /"\$@"' prim-hook-launcher-v1 (?<bin>prim-[a-z-]+)(?<args>(?: [-\w]+)*)/u.exec(
    command,
  );
  if (!match?.groups) throw new Error(`not a stable hook command: ${command}`);
  return { bin: match.groups.bin, args: match.groups.args.trim() };
}

type Nested = { hooks?: Record<string, { hooks?: { command?: string }[] }[] | undefined> };
type Flat = { hooks?: Record<string, { command: string }[]> };

/** Every [event, command] of a Claude Code or Codex settings file. */
function nestedCommands(settings: Nested): [string, string][] {
  return Object.entries(settings.hooks ?? {}).flatMap(([event, entries]) =>
    (entries ?? []).flatMap((entry) =>
      (entry.hooks ?? []).map((hook): [string, string] => [event, hook.command ?? ""]),
    ),
  );
}

/** Every [event, command] of a Cursor or Hermes hooks map. */
function flatCommands(hooks: Flat["hooks"]): [string, string][] {
  return Object.entries(hooks ?? {}).flatMap(([event, entries]) =>
    entries.map((entry): [string, string] => [event, entry.command]),
  );
}

/** A Claude Code hook command as frozen text: SessionEnd alone is detached. */
function claudeText(event: string, bin: string, guard = ""): string {
  return event === "SessionEnd" ? detached(released(bin, "", guard)) : released(bin, "", guard);
}

const readJson = (path: string) => JSON.parse(readFileSync(path, "utf8"));
const projectFile = () => join(repo, ".claude", "settings.json");
const userFile = () => join(home, ".claude", "settings.json");

/** Claude Code settings as an install wrote them, every command as frozen text. */
async function claudeSettings(guard: string): Promise<Record<string, unknown>> {
  const claude = await import("./claude-install.js");
  const settings = claude.applyInstall({});
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    for (const entry of entries ?? []) {
      for (const hook of entry.hooks ?? []) {
        hook.command = claudeText(event, tail(hook.command ?? "").bin, guard);
      }
    }
  }
  if (settings.statusLine) settings.statusLine.command = released("prim-statusline", "", guard);
  return settings;
}

function writeProjectFile(settings: unknown): void {
  mkdirSync(dirname(projectFile()), { recursive: true });
  writeFileSync(projectFile(), `${JSON.stringify(settings, null, 2)}\n`);
}

describe("every install but a Claude Code project install writes the released text", () => {
  it("Claude Code at user scope, hooks and statusline", async () => {
    const claude = await import("./claude-install.js");
    claude.performInstall("user", false);

    const settings = readJson(userFile());
    const commands = nestedCommands(settings);
    expect(commands).toHaveLength(13);
    for (const [event, command] of commands) {
      expect(command).toBe(claudeText(event, tail(command).bin));
    }
    expect(settings.statusLine.command).toBe(released("prim-statusline"));
  });

  it("the cloud user-scope wrapper", async () => {
    const claude = await import("./claude-install.js");
    claude.performCloudUserInstall();

    const settings = readJson(userFile());
    const commands = nestedCommands(settings);
    expect(commands).toHaveLength(13);
    for (const [event, command] of commands) {
      const { bin } = tail(command);
      expect(command).toBe(deferred(claudeText(event, bin), bin));
    }
    expect(settings.statusLine).toBeUndefined();
  });

  it("Codex", async () => {
    const codex = await import("./codex-install.js");
    const commands = nestedCommands(codex.applyInstall({}));
    expect(commands.length).toBeGreaterThan(0);
    for (const [, command] of commands) {
      expect(command).toBe(released(tail(command).bin, "--agent codex"));
    }
  });

  it.each(["project", "user"] as const)("Cursor at %s scope, and its footer", async (scope) => {
    const cursor = await import("./cursor-install.js");
    const commands = flatCommands(cursor.applyCursorInstall({}, scope).hooks);
    expect(commands.length).toBeGreaterThan(0);
    for (const [event, command] of commands) {
      expect(command).toBe(
        released(tail(command).bin, `--agent cursor --event ${event} --scope ${scope}`),
      );
    }
    const footer = cursor.applyCursorFooterInstall({}).config.statusLine as { command: string };
    expect(footer.command).toBe(released("prim-statusline"));
  });

  it("Hermes", async () => {
    const hermes = await import("./hermes-install.js");
    const commands = flatCommands(hermes.applyInstall({}, false));
    expect(commands.length).toBeGreaterThan(0);
    for (const [, command] of commands) {
      expect(command).toBe(released(tail(command).bin, "--agent hermes"));
    }
  });

  it("a native Cursor config holding it still suppresses the imported Claude handler", async () => {
    const cursor = await import("./cursor-install.js");
    const { shouldSuppressImportedCursorHandler } = await import("../hooks/cursor-coexistence.js");
    const envelope = {
      cursor_version: "3.19.19",
      conversation_id: "conversation-1",
      generation_id: "generation-1",
      hook_event_name: "preToolUse",
      workspace_roots: [repo],
    };
    const native = {
      user: join(home, ".cursor", "hooks.json"),
      project: join(repo, ".cursor", "hooks.json"),
    };
    for (const scope of ["user", "project"] as const) {
      const settings = cursor.applyCursorInstall({}, scope);
      for (const [event, command] of flatCommands(settings.hooks)) {
        expect(command).toBe(
          released(tail(command).bin, `--agent cursor --event ${event} --scope ${scope}`),
        );
      }
      expect(shouldSuppressImportedCursorHandler(envelope, "prim-pre-tool-use")).toBe(false);
      mkdirSync(dirname(native[scope]), { recursive: true });
      writeFileSync(native[scope], `${JSON.stringify(settings, null, 2)}\n`);
      expect(shouldSuppressImportedCursorHandler(envelope, "prim-pre-tool-use")).toBe(true);
      rmSync(native[scope]);
    }
  });
});

describe("a Claude Code project install", () => {
  it("writes the guarded text, and a second install changes nothing", async () => {
    const claude = await import("./claude-install.js");
    expect(claude.performInstall("project", false).changed).toBe(true);

    const settings = readJson(projectFile());
    const commands = nestedCommands(settings);
    expect(commands).toHaveLength(13);
    for (const [event, command] of commands) {
      expect(command).toBe(claudeText(event, tail(command).bin, GUARD));
    }
    expect(settings.statusLine.command).toBe(released("prim-statusline", "", GUARD));
    expect(settings).toEqual(await claudeSettings(GUARD));
    expect(claude.performStatus().project.complete).toBe(true);
    expect(claude.performInstall("project", false).changed).toBe(false);
    expect(existsSync(userFile())).toBe(false);
  });

  it("does nothing, silently, on a machine without prim", async () => {
    const claude = await import("./claude-install.js");
    claude.performInstall("project", false);
    const settings = readJson(projectFile());
    const elsewhere = join(root, "another-home");
    mkdirSync(elsewhere);

    const commands = [
      ...nestedCommands(settings).map(([, command]) => command),
      settings.statusLine.command as string,
    ];
    expect(commands).toHaveLength(14);
    for (const command of commands) {
      // `wait` lets a detached SessionEnd body finish inside the observed shell.
      const result = spawnSync("/bin/sh", ["-c", `${command}\nwait`], {
        env: { PATH: process.env.PATH, HOME: elsewhere, CLAUDE_PROJECT_DIR: repo },
        input: '{"payload":true}',
        encoding: "utf8",
      });
      expect(result, command).toMatchObject({ status: 0, stdout: "", stderr: "" });
    }
  });

  it("upgrades a committed file holding the released text, once and unforced", async () => {
    const claude = await import("./claude-install.js");
    writeProjectFile(await claudeSettings(""));

    expect(claude.performInstall("project", false).changed).toBe(true);
    expect(readJson(projectFile())).toEqual(await claudeSettings(GUARD));
    expect(claude.performInstall("project", false).changed).toBe(false);
  });

  describe.each([
    ["released", ""],
    ["guarded", GUARD],
  ])("committed with the %s text", (_label, guard) => {
    beforeEach(async () => {
      writeProjectFile(await claudeSettings(guard));
    });

    it("is complete, healthy, and a project install", async () => {
      const claude = await import("./claude-install.js");
      const { classifyClaudeHooks } = await import("./doctor.js");
      const { hasProjectPrimInstall } = await import("../lib/activation.js");

      const status = claude.performStatus();
      expect(status.project).toMatchObject({
        present: true,
        gate: true,
        capture: true,
        feedback: true,
        complete: true,
        statusline: true,
        statuslineState: "primitive",
      });
      expect(status.user.present).toBe(false);
      expect(classifyClaudeHooks([status.project, status.user])).toMatchObject({ status: "ok" });
      expect(hasProjectPrimInstall(repo)).toBe(true);
      expect(new Set(claude.inspectHookRuntimeResolutions().map(({ kind }) => kind))).toEqual(
        new Set(["stable_launcher"]),
      );
    });

    it("makes the cloud user-scope wrapper step aside", async () => {
      const claude = await import("./claude-install.js");
      const wrapped = claude.applyInstall(
        {},
        { installStatusline: false, wrapCommand: claude.deferToProjectInstall },
      );
      const launcher = join(home, ".config", "prim", "prim-hook-launcher-v1");
      const ran = join(home, "ran");
      mkdirSync(dirname(launcher), { recursive: true });
      writeFileSync(launcher, `#!/bin/sh\necho "$1" >> '${ran}'\n`, { mode: 0o700 });
      const elsewhere = join(root, "elsewhere");
      mkdirSync(elsewhere);

      /** The bins the launcher was entered for when every wrapped hook fires. */
      const entered = (project: string): string[] => {
        rmSync(ran, { force: true });
        for (const [, command] of nestedCommands(wrapped)) {
          // `wait` lets a detached SessionEnd body finish inside the observed shell.
          const result = spawnSync("/bin/sh", ["-c", `${command}\nwait`], {
            env: { PATH: process.env.PATH, HOME: home, CLAUDE_PROJECT_DIR: project },
            input: "{}",
            encoding: "utf8",
          });
          expect(result.status, result.stderr).toBe(0);
        }
        return existsSync(ran) ? readFileSync(ran, "utf8").trim().split("\n") : [];
      };

      expect(entered(elsewhere)).toHaveLength(13);
      expect(entered(repo)).toEqual([]);
    });

    it("is removed by uninstall", async () => {
      const claude = await import("./claude-install.js");
      expect(claude.performUninstall("project").changed).toBe(true);

      expect(readJson(projectFile())).toEqual({ hooks: {} });
      expect(claude.performStatus().project.present).toBe(false);
    });
  });
});
