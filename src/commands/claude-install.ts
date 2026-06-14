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

// M6: additional hook + statusLine surfaces wired by `prim claude install`.
const PRIM_POST_TOOL_USE_COMMAND = "prim-post-tool-use";
const PRIM_SESSION_START_COMMAND = "prim-session-start";
const PRIM_SESSION_END_COMMAND = "prim-session-end";
const PRIM_STATUSLINE_COMMAND = "prim statusline";
// Re-run the statusline on a 5s idle timer (Claude Code's `refreshInterval`).
// Claude Code only re-renders the statusline on conversation events by
// default, so a "team: N online" count goes stale between prompts; this adds
// the idle poll so presence updates without the user submitting anything. 5s
// ≈ the daemon's 30s heartbeat cadence — live-feeling, but light on spawns.
const PRIM_STATUSLINE_REFRESH_SECONDS = 5;

type HookSurface = {
  eventName: string;
  command: string;
  matcher?: string;
};

const M6_HOOK_SURFACES: HookSurface[] = [
  {
    eventName: "PostToolUse",
    command: PRIM_POST_TOOL_USE_COMMAND,
    matcher: "Edit|Write|MultiEdit",
  },
  { eventName: "SessionStart", command: PRIM_SESSION_START_COMMAND },
  { eventName: "SessionEnd", command: PRIM_SESSION_END_COMMAND },
];

const USER_SCOPE_PATH = join(homedir(), ".claude", "settings.json");
const PROJECT_SCOPE_PATH = join(process.cwd(), ".claude", "settings.json");

export type Scope = "user" | "project";

export type ClaudeSettings = {
  hooks?: {
    PreToolUse?: HookMatcher[];
    PostToolUse?: HookMatcher[];
    SessionStart?: HookMatcher[];
    SessionEnd?: HookMatcher[];
    [key: string]: HookMatcher[] | undefined;
  };
  statusLine?: {
    type?: string;
    command?: string;
    padding?: number;
    refreshInterval?: number;
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

// ── M6 install helpers ─────────────────────────────────────────────────────

function hasCommand(matcher: HookMatcher, command: string): boolean {
  return matcher.hooks?.some((h) => h.command === command) ?? false;
}

export function applyInstallHookSurface(
  settings: ClaudeSettings,
  surface: HookSurface,
  options: { force?: boolean } = {},
): ClaudeSettings {
  const out: ClaudeSettings = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}) },
  };
  const existing = out.hooks?.[surface.eventName] ?? [];
  const filtered = existing.filter((m) => !hasCommand(m, surface.command));
  const newEntry: HookMatcher = {
    hooks: [{ type: "command", command: surface.command }],
  };
  if (surface.matcher !== undefined) {
    newEntry.matcher = surface.matcher;
  }
  const hasExistingCanonical = existing.some(
    (m) =>
      m.matcher === surface.matcher &&
      m.hooks?.length === 1 &&
      m.hooks[0].command === surface.command,
  );
  if (hasExistingCanonical && !options.force) {
    return out;
  }
  if (out.hooks) {
    out.hooks[surface.eventName] = [...filtered, newEntry];
  }
  return out;
}

export function applyUninstallHookSurface(
  settings: ClaudeSettings,
  surface: HookSurface,
): ClaudeSettings {
  const out: ClaudeSettings = {
    ...settings,
    hooks: { ...(settings.hooks ?? {}) },
  };
  const existing = out.hooks?.[surface.eventName] ?? [];
  const filtered = existing.filter((m) => !hasCommand(m, surface.command));
  if (out.hooks) {
    out.hooks[surface.eventName] = filtered.length === 0 ? undefined : filtered;
  }
  return out;
}

export function applyInstallStatusLine(
  settings: ClaudeSettings,
  options: { force?: boolean } = {},
): ClaudeSettings {
  const out: ClaudeSettings = { ...settings };
  const existing = settings.statusLine;
  // "Canonical" now also requires refreshInterval to be present, so re-running
  // install upgrades an older prim statusLine that predates it — it adds the
  // idle-refresh timer instead of early-returning and leaving presence stale.
  // A prim statusLine that already carries any refreshInterval is left as-is
  // (a user's custom interval is preserved; only --force resets it).
  const isCanonical =
    existing?.type === "command" &&
    existing?.command === PRIM_STATUSLINE_COMMAND &&
    existing?.refreshInterval !== undefined;
  if (isCanonical && !options.force) {
    return out;
  }
  if (existing && existing.command !== PRIM_STATUSLINE_COMMAND && !options.force) {
    // Don't clobber a user-defined statusLine — only canonicalize our own.
    return out;
  }
  out.statusLine = {
    type: "command",
    command: PRIM_STATUSLINE_COMMAND,
    padding: 1,
    refreshInterval: PRIM_STATUSLINE_REFRESH_SECONDS,
  };
  return out;
}

export function applyUninstallStatusLine(settings: ClaudeSettings): ClaudeSettings {
  const out: ClaudeSettings = { ...settings };
  if (out.statusLine?.command === PRIM_STATUSLINE_COMMAND) {
    out.statusLine = undefined;
  }
  return out;
}

function isHookSurfaceInstalled(settings: ClaudeSettings, surface: HookSurface): boolean {
  return (settings.hooks?.[surface.eventName] ?? []).some((m) => hasCommand(m, surface.command));
}

function isStatusLineInstalled(settings: ClaudeSettings): boolean {
  return settings.statusLine?.command === PRIM_STATUSLINE_COMMAND;
}

export function isFullyInstalled(settings: ClaudeSettings): boolean {
  return (
    isInstalled(settings) &&
    M6_HOOK_SURFACES.every((s) => isHookSurfaceInstalled(settings, s)) &&
    isStatusLineInstalled(settings)
  );
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
  const wasFullyInstalled = isFullyInstalled(before);
  let after = applyInstall(before, { force });
  for (const surface of M6_HOOK_SURFACES) {
    after = applyInstallHookSurface(after, surface, { force });
  }
  after = applyInstallStatusLine(after, { force });
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    writeSettings(path, after);
  }
  return {
    scope,
    path,
    installed: isFullyInstalled(after),
    changed: !wasFullyInstalled || changed,
  };
}

export function performUninstall(scope: Scope): InstallResult {
  const path = settingsPathFor(scope);
  const before = readSettings(path);
  let after = applyUninstall(before);
  for (const surface of M6_HOOK_SURFACES) {
    after = applyUninstallHookSurface(after, surface);
  }
  after = applyUninstallStatusLine(after);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    writeSettings(path, after);
  }
  return {
    scope,
    path,
    installed: isFullyInstalled(after),
    changed,
  };
}

export type ScopeStatus = {
  path: string;
  installed: boolean;
  surfaces: {
    preToolUse: boolean;
    postToolUse: boolean;
    sessionStart: boolean;
    sessionEnd: boolean;
    statusLine: boolean;
  };
};

function statusForScope(path: string): ScopeStatus {
  const settings = readSettings(path);
  const [postToolUse, sessionStart, sessionEnd] = M6_HOOK_SURFACES.map((s) =>
    isHookSurfaceInstalled(settings, s),
  );
  return {
    path,
    installed: isFullyInstalled(settings),
    surfaces: {
      preToolUse: isInstalled(settings),
      postToolUse,
      sessionStart,
      sessionEnd,
      statusLine: isStatusLineInstalled(settings),
    },
  };
}

export function performStatus(): {
  user: ScopeStatus;
  project: ScopeStatus;
} {
  return {
    user: statusForScope(USER_SCOPE_PATH),
    project: statusForScope(PROJECT_SCOPE_PATH),
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
    .description(
      "Register the full prim Claude Code integration (PreToolUse + PostToolUse + SessionStart + SessionEnd hooks + statusLine)",
    )
    .option(
      "--scope <scope>",
      "user (default, ~/.claude/settings.json) or project (./.claude/settings.json)",
    )
    .option("--force", "Replace any existing prim hook entries")
    .action((opts: { scope?: string; force?: boolean }) => {
      const scope = resolveScope(opts.scope);
      const result = performInstall(scope, opts.force ?? false);
      if (result.changed) {
        console.error(`[prim] integration installed (${scope} scope) at ${result.path}`);
      } else {
        console.error(`[prim] integration already present at ${result.path} (no changes)`);
      }
      console.log(JSON.stringify(result, null, 2));
    });

  claude
    .command("uninstall")
    .description("Remove the prim hooks + statusLine from settings.json")
    .option(
      "--scope <scope>",
      "user (default, ~/.claude/settings.json) or project (./.claude/settings.json)",
    )
    .action((opts: { scope?: string }) => {
      const scope = resolveScope(opts.scope);
      const result = performUninstall(scope);
      if (result.changed) {
        console.error(`[prim] integration removed from ${result.path}`);
      } else {
        console.error(`[prim] no prim integration to remove at ${result.path} (nothing changed)`);
      }
      console.log(JSON.stringify(result, null, 2));
    });

  claude
    .command("status")
    .description("Report whether the prim integration is installed at user / project scope")
    .action(() => {
      const result = performStatus();
      const renderScope = (label: string, status: ScopeStatus) => {
        const badge = status.installed ? "✓" : "✗";
        const surfaces = Object.entries(status.surfaces)
          .map(([k, v]) => `${v ? "✓" : "✗"} ${k}`)
          .join("  ");
        return `[prim] ${badge} ${label} (${status.path})\n[prim]     ${surfaces}`;
      };
      console.error(
        `${renderScope("user", result.user)}\n${renderScope("project", result.project)}`,
      );
      console.log(JSON.stringify(result, null, 2));
    });
}
