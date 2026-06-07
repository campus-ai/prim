/**
 * `prim claude install [--scope=user|project]` — register the
 * PreToolUse hook in Claude Code's settings.json so Edit/Write/
 * MultiEdit operations get intercepted by `prim-pre-tool-use`.
 *
 *   prim claude install              # writes ~/.claude/settings.json
 *   prim claude install --scope=project
 *   prim claude uninstall
 *   prim claude status
 *
 * The settings.json format follows Claude Code's spec:
 *
 *   {
 *     "hooks": {
 *       "PreToolUse": [
 *         {
 *           "matcher": "Edit|Write|MultiEdit",
 *           "hooks": [{"type": "command", "command": "prim-pre-tool-use"}]
 *         }
 *       ]
 *     }
 *   }
 *
 * The installer preserves any existing keys / matchers — it only
 * adds or replaces the entry whose hook command is exactly
 * `prim-pre-tool-use`. Idempotent. AX contract: STDOUT is the
 * resulting settings.json block as JSON; STDERR is the verdict.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";

const PRIM_HOOK_COMMAND = "prim-pre-tool-use";
const PRIM_HOOK_MATCHER = "Edit|Write|MultiEdit";

const USER_SCOPE_PATH = join(homedir(), ".claude", "settings.json");
const PROJECT_SCOPE_PATH = join(process.cwd(), ".claude", "settings.json");

export type Scope = "user" | "project";

export type ClaudeSettings = {
  hooks?: {
    PreToolUse?: HookMatcher[];
    [key: string]: HookMatcher[] | undefined;
  };
  [key: string]: unknown;
};

export type HookMatcher = {
  matcher?: string;
  hooks?: HookCommand[];
};

export type HookCommand = {
  type?: string;
  command?: string;
};

function settingsPathFor(scope: Scope): string {
  return scope === "user" ? USER_SCOPE_PATH : PROJECT_SCOPE_PATH;
}

function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) {
    return {};
  }
  try {
    const raw = readFileSync(path, "utf-8");
    return JSON.parse(raw) as ClaudeSettings;
  } catch {
    return {};
  }
}

function writeSettings(path: string, settings: ClaudeSettings): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  // 2-space indentation, trailing newline — same shape Claude Code
  // emits on its own settings management.
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf-8");
}

function hasPrimHook(matcher: HookMatcher): boolean {
  return matcher.hooks?.some((h) => h.command === PRIM_HOOK_COMMAND) ?? false;
}

/**
 * Pure helper — returns a new `ClaudeSettings` with the prim
 * PreToolUse hook installed, leaving any other entries untouched.
 * Replaces an existing prim entry if `force` is true OR if the
 * existing entry's matcher differs from the canonical form.
 */
export function applyInstall(
  settings: ClaudeSettings,
  options: { force?: boolean } = {},
): ClaudeSettings {
  const out: ClaudeSettings = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}) },
  };
  const existing = out.hooks?.PreToolUse ?? [];
  const filtered = existing.filter((m) => !hasPrimHook(m));
  const newEntry: HookMatcher = {
    matcher: PRIM_HOOK_MATCHER,
    hooks: [{ type: "command", command: PRIM_HOOK_COMMAND }],
  };
  // When force is false and the existing prim entry already matches
  // the canonical form, preserve it (idempotent no-op). When force
  // is true, the filter removed it and we just append the canonical.
  const hasExistingCanonical = existing.some(
    (m) =>
      m.matcher === PRIM_HOOK_MATCHER &&
      m.hooks?.length === 1 &&
      m.hooks[0].command === PRIM_HOOK_COMMAND,
  );
  if (hasExistingCanonical && !options.force) {
    return out;
  }
  if (out.hooks) {
    out.hooks.PreToolUse = [...filtered, newEntry];
  }
  return out;
}

export function applyUninstall(settings: ClaudeSettings): ClaudeSettings {
  const out: ClaudeSettings = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}) },
  };
  const existing = out.hooks?.PreToolUse ?? [];
  const filtered = existing.filter((m) => !hasPrimHook(m));
  if (out.hooks) {
    if (filtered.length === 0) {
      out.hooks.PreToolUse = undefined;
    } else {
      out.hooks.PreToolUse = filtered;
    }
  }
  return out;
}

export function isInstalled(settings: ClaudeSettings): boolean {
  return (settings.hooks?.PreToolUse ?? []).some(hasPrimHook);
}

type InstallResult = {
  scope: Scope;
  path: string;
  installed: boolean;
  changed: boolean;
};

export function performInstall(scope: Scope, force: boolean): InstallResult {
  const path = settingsPathFor(scope);
  const before = readSettings(path);
  const wasInstalled = isInstalled(before);
  const after = applyInstall(before, { force });
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    writeSettings(path, after);
  }
  return {
    scope,
    path,
    installed: isInstalled(after),
    changed: !wasInstalled || changed,
  };
}

export function performUninstall(scope: Scope): InstallResult {
  const path = settingsPathFor(scope);
  const before = readSettings(path);
  const after = applyUninstall(before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    writeSettings(path, after);
  }
  return {
    scope,
    path,
    installed: isInstalled(after),
    changed,
  };
}

export function performStatus(): {
  user: { path: string; installed: boolean };
  project: { path: string; installed: boolean };
} {
  return {
    user: {
      path: USER_SCOPE_PATH,
      installed: isInstalled(readSettings(USER_SCOPE_PATH)),
    },
    project: {
      path: PROJECT_SCOPE_PATH,
      installed: isInstalled(readSettings(PROJECT_SCOPE_PATH)),
    },
  };
}

function resolveScope(input: string | undefined): Scope {
  return input === "project" ? "project" : "user";
}

export function registerClaudeCommands(program: Command): void {
  const claude = program
    .command("claude")
    .description("Manage the prim Claude Code integration (PreToolUse hook installation)");

  claude
    .command("install")
    .description("Register the prim PreToolUse hook in Claude Code's settings.json")
    .option(
      "--scope <scope>",
      "user (default, ~/.claude/settings.json) or project (./.claude/settings.json)",
    )
    .option("--force", "Replace any existing prim hook entry")
    .action((opts: { scope?: string; force?: boolean }) => {
      const scope = resolveScope(opts.scope);
      const result = performInstall(scope, opts.force ?? false);
      if (result.changed) {
        console.error(`[prim] PreToolUse hook installed (${scope} scope) at ${result.path}`);
      } else {
        console.error(`[prim] PreToolUse hook already present at ${result.path} (no changes)`);
      }
      console.log(JSON.stringify(result, null, 2));
    });

  claude
    .command("uninstall")
    .description("Remove the prim PreToolUse hook from settings.json")
    .option(
      "--scope <scope>",
      "user (default, ~/.claude/settings.json) or project (./.claude/settings.json)",
    )
    .action((opts: { scope?: string }) => {
      const scope = resolveScope(opts.scope);
      const result = performUninstall(scope);
      if (result.changed) {
        console.error(`[prim] PreToolUse hook removed from ${result.path}`);
      } else {
        console.error(`[prim] no prim hook to remove at ${result.path} (nothing changed)`);
      }
      console.log(JSON.stringify(result, null, 2));
    });

  claude
    .command("status")
    .description("Report whether the prim PreToolUse hook is installed at user / project scope")
    .action(() => {
      const result = performStatus();
      const userBadge = result.user.installed ? "✓" : "✗";
      const projectBadge = result.project.installed ? "✓" : "✗";
      console.error(
        `[prim] ${userBadge} user (${result.user.path})\n` +
          `[prim] ${projectBadge} project (${result.project.path})`,
      );
      console.log(JSON.stringify(result, null, 2));
    });
}
