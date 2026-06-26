/**
 * `prim claude install|uninstall|status` — manage the prim Claude Code
 * integration in settings.json.
 *
 * One command surface registers every prim binary Claude Code drives:
 *   - prim-hook (passive capture) at matcher "*" on every hook event, so the
 *     decision journal sees the full session.
 *   - prim-pre-tool-use (the conflict gate) on PreToolUse, and
 *     prim-post-tool-use (server move ingest + verdict footer) on PostToolUse,
 *     both at matcher "Edit|Write|MultiEdit".
 *   - prim-session-start / prim-session-end on the session boundaries, so the
 *     daemon's presence reflects live sessions.
 *   - the `prim statusline` statusLine, so the editor shows "team: N online".
 *
 *   prim claude install                 # <repo-root>/.claude/settings.json (project, default)
 *   prim claude install --scope=user    # ~/.claude/settings.json (machine-global)
 *   prim claude install --force         # replace drifted prim entries
 *   prim claude uninstall               # strip every prim entry
 *   prim claude status                  # report each surface per scope
 *
 * Merges; never overwrites. Unrelated matchers, non-prim commands, and a
 * user-defined statusLine are preserved — install only adds/replaces the prim
 * surfaces, uninstall only removes them. Idempotent. Writes atomically
 * (tmp + fsync + rename) so a crash can never leave a torn settings.json. AX
 * contract: STDOUT is the resulting JSON; STDERR is the human verdict.
 */
import { execSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { commandMatchesBin, hookShimCommand } from "../lib/bin-path.js";

// Stable bin identities (npm `bin` names). The command actually written into
// settings.json is the resolution shim from hookShimCommand() (PATH → local →
// npx@latest); these names are what we match on to recognize and upgrade older
// bare-name installs.
const CAPTURE_BIN = "prim-hook";
const GATE_BIN = "prim-pre-tool-use";
const POST_TOOL_USE_BIN = "prim-post-tool-use";
const SESSION_START_BIN = "prim-session-start";
const SESSION_END_BIN = "prim-session-end";
// The statusline rides the `prim` bin, invoked as `… statusline`.
const STATUSLINE_BIN = "prim";
const STATUSLINE_ARGS = "statusline";
const STATUSLINE_COMMAND = hookShimCommand(STATUSLINE_BIN, STATUSLINE_ARGS);
// Claude Code re-renders the statusLine only on conversation events by
// default, so a "team: N online" count goes stale between prompts. The idle
// refresh poll keeps presence live without the user submitting anything; 5s ≈
// the daemon's 30s heartbeat cadence — live-feeling, but light on spawns.
const STATUSLINE_REFRESH_SECONDS = 5;
const PRIM_BINS: readonly string[] = [
  CAPTURE_BIN,
  GATE_BIN,
  POST_TOOL_USE_BIN,
  SESSION_START_BIN,
  SESSION_END_BIN,
];

const JSON_INDENT = 2;

const USER_SCOPE_PATH = join(homedir(), ".claude", "settings.json");

/**
 * Project scope is anchored at the git repository root, not the bare cwd: Claude
 * Code and Codex both resolve project-local config from the repo root, so a hook
 * file written under a subdirectory would never be read (a silently-inert
 * install). Falls back to the cwd outside a git work tree, so project scope still
 * works in a non-repo dir. Shared with codex-install.ts. Resolved lazily (not at
 * module load) so unrelated prim commands never shell out to git.
 */
export function projectRoot(): string {
  try {
    return execSync("git rev-parse --show-toplevel", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return process.cwd();
  }
}

const projectScopePath = (): string => join(projectRoot(), ".claude", "settings.json");

// Capture rides every hook event at the wildcard matcher; the gate and the
// PostToolUse ingest hook ride their edit tools; the session hooks notify the
// daemon on session boundaries. PreToolUse and PostToolUse each carry two prim
// entries (capture + their dedicated hook), which is intended.
const CAPTURE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "SubagentStop",
] as const;

export type Registration = {
  event: string;
  matcher: string;
  /** npm bin name — the stable identity matched on for install/uninstall. */
  bin: string;
  /** The absolute, PATH-independent command written into settings.json. */
  command: string;
};

export function makeRegistration(
  event: string,
  matcher: string,
  bin: string,
  args = "",
): Registration {
  return { event, matcher, bin, command: hookShimCommand(bin, args) };
}

const REGISTRATIONS: Registration[] = [
  ...CAPTURE_EVENTS.map((event) => makeRegistration(event, "*", CAPTURE_BIN)),
  makeRegistration("PreToolUse", "Edit|Write|MultiEdit", GATE_BIN),
  makeRegistration("PostToolUse", "Edit|Write|MultiEdit", POST_TOOL_USE_BIN),
  makeRegistration("SessionStart", "*", SESSION_START_BIN),
  makeRegistration("SessionEnd", "*", SESSION_END_BIN),
];

export type Scope = "user" | "project";

export type HookCommand = {
  type?: string;
  command?: string;
};

export type HookEntry = {
  matcher?: string;
  hooks?: HookCommand[];
};

export type StatusLineConfig = {
  type?: string;
  command?: string;
  refreshInterval?: number;
};

export type PermissionsConfig = {
  allow?: string[];
  deny?: string[];
  ask?: string[];
  [key: string]: unknown;
};

export type ClaudeSettings = {
  hooks?: Record<string, HookEntry[] | undefined>;
  statusLine?: StatusLineConfig;
  permissions?: PermissionsConfig;
  [key: string]: unknown;
};

// Pre-authorize the agent's own prim invocations so a copy/paste onboarding
// (or any later `decisions`/`welcome` call) doesn't stall on a permission
// prompt. Scoped to the exact `npx @latest` form the docs use — not a blanket
// Bash grant. Removed cleanly on uninstall.
export const PRIM_PERMISSION_RULE = "Bash(npx --yes @primitive.ai/prim@latest:*)";

function settingsPathFor(scope: Scope): string {
  return scope === "user" ? USER_SCOPE_PATH : projectScopePath();
}

export function readSettings(path: string): ClaudeSettings {
  if (!existsSync(path)) {
    return {};
  }
  const raw = readFileSync(path, "utf-8");
  try {
    return JSON.parse(raw) as ClaudeSettings;
  } catch (err) {
    // Never clobber a settings.json we could not parse — surface it loudly so
    // the user fixes their JSON instead of silently losing their config.
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${path} is not valid JSON: ${detail}`);
  }
}

export function entryHasCommand(entry: HookEntry, bin: string): boolean {
  return entry.hooks?.some((h) => commandMatchesBin(h.command, bin)) ?? false;
}

function canonicalEntry(reg: Registration): HookEntry {
  return { matcher: reg.matcher, hooks: [{ type: "command", command: reg.command }] };
}

/**
 * Remove every command matching `bin` from an event's entry list at HOOK
 * granularity: a hook co-located in a multi-hook entry is stripped without
 * dropping its siblings, and an entry is removed only once its hooks array is
 * empty. This is what keeps a hand-merged `{ hooks: [otherCmd, prim-hook] }`
 * entry's non-prim command alive across install/uninstall. Matching by bin
 * identity (not exact string) strips both the legacy bare name and the current
 * absolute form, so an older install is cleanly superseded.
 */
export function stripCommand(list: HookEntry[], bin: string): HookEntry[] {
  const out: HookEntry[] = [];
  for (const e of list) {
    const hooks = (e.hooks ?? []).filter((h) => !commandMatchesBin(h.command, bin));
    if (hooks.length > 0) {
      out.push({ ...e, hooks });
    }
  }
  return out;
}

/**
 * Ensure one registration's entry is present on its event list. Idempotent: a
 * canonical single-hook entry already carrying THIS exact command is a no-op
 * unless `force`. Otherwise only this bin's entries are stripped (legacy bare
 * or stale absolute) before the canonical entry is appended — so a plain
 * re-install upgrades an older bare-name install to the absolute form in place,
 * while a sibling prim binary's entry (and any co-located non-prim hook)
 * survives.
 */
export function ensureRegistration(
  list: HookEntry[],
  reg: Registration,
  force: boolean,
): HookEntry[] {
  const hasCanonical = list.some(
    (e) => e.matcher === reg.matcher && e.hooks?.length === 1 && e.hooks[0].command === reg.command,
  );
  if (hasCanonical && !force) {
    return list;
  }
  return [...stripCommand(list, reg.bin), canonicalEntry(reg)];
}

const LEGACY_STATUSLINE_COMMAND = "prim statusline";
function isPrimStatusLine(settings: ClaudeSettings): boolean {
  const s = settings.statusLine;
  if (s?.type !== "command") {
    return false;
  }
  const c = (s.command ?? "").trim();
  // Legacy bare form, or our shim (which references the package and `statusline`
  // in its branches). A user's own statusLine references neither.
  return (
    c === LEGACY_STATUSLINE_COMMAND ||
    (c.includes("@primitive.ai/prim") && c.includes("statusline"))
  );
}

/**
 * Install the prim statusline ONLY when the slot is empty or already ours — a
 * user's own statusLine is never clobbered. Always writes the refreshInterval,
 * so re-running install upgrades an older prim statusLine that predates it.
 */
function applyStatusLine(settings: ClaudeSettings): ClaudeSettings {
  if (settings.statusLine && !isPrimStatusLine(settings)) {
    return settings;
  }
  return {
    ...settings,
    statusLine: {
      type: "command",
      command: STATUSLINE_COMMAND,
      refreshInterval: STATUSLINE_REFRESH_SECONDS,
    },
  };
}

/**
 * Ensure the prim allow-rule is present in permissions.allow, idempotently and
 * without disturbing the user's other permission entries. Pre-authorizing prim
 * here means the grant originates from project/user settings (trusted) rather
 * than a fetched setup doc — which is the scope an agent cannot self-approve.
 */
function applyPermissions(settings: ClaudeSettings): ClaudeSettings {
  const permissions = settings.permissions ?? {};
  const allow = permissions.allow ?? [];
  if (allow.includes(PRIM_PERMISSION_RULE)) {
    return settings;
  }
  return {
    ...settings,
    permissions: { ...permissions, allow: [...allow, PRIM_PERMISSION_RULE] },
  };
}

/**
 * Drop the prim allow-rule on uninstall, leaving every other permission intact.
 * An emptied `allow` array and an emptied `permissions` object are removed so
 * uninstall returns the settings to their pre-prim shape.
 */
function removePrimPermission(settings: ClaudeSettings): ClaudeSettings {
  const permissions = settings.permissions;
  if (!permissions?.allow?.includes(PRIM_PERMISSION_RULE)) {
    return settings;
  }
  const allow = permissions.allow.filter((rule) => rule !== PRIM_PERMISSION_RULE);
  // Set emptied fields to undefined rather than deleting — atomicWrite's
  // JSON.stringify drops undefined keys, the same idiom applyUninstall uses for
  // statusLine. Drop the whole permissions object once nothing defined remains.
  const nextPermissions: PermissionsConfig = {
    ...permissions,
    allow: allow.length > 0 ? allow : undefined,
  };
  const hasOtherPerms = Object.values(nextPermissions).some((v) => v !== undefined);
  return { ...settings, permissions: hasOtherPerms ? nextPermissions : undefined };
}

export function applyInstall(
  settings: ClaudeSettings,
  options: { force?: boolean } = {},
): ClaudeSettings {
  const hooks: Record<string, HookEntry[] | undefined> = { ...(settings.hooks ?? {}) };
  for (const reg of REGISTRATIONS) {
    hooks[reg.event] = ensureRegistration(hooks[reg.event] ?? [], reg, options.force ?? false);
  }
  return applyPermissions(applyStatusLine({ ...settings, hooks }));
}

export function applyUninstall(settings: ClaudeSettings): ClaudeSettings {
  const source = settings.hooks ?? {};
  const hooks: Record<string, HookEntry[] | undefined> = {};
  for (const event of Object.keys(source)) {
    let list = source[event] ?? [];
    for (const bin of PRIM_BINS) {
      list = stripCommand(list, bin);
    }
    // Events that become empty are dropped entirely (not left as []).
    if (list.length > 0) {
      hooks[event] = list;
    }
  }
  const next: ClaudeSettings = { ...settings, hooks };
  // Remove our statusline; leave a user-defined one untouched.
  if (isPrimStatusLine(next)) {
    next.statusLine = undefined;
  }
  return removePrimPermission(next);
}

function captureInstalled(settings: ClaudeSettings): boolean {
  return CAPTURE_EVENTS.some((event) =>
    (settings.hooks?.[event] ?? []).some((e) => entryHasCommand(e, CAPTURE_BIN)),
  );
}

function statuslineInstalled(settings: ClaudeSettings): boolean {
  return isPrimStatusLine(settings);
}

/**
 * The unified surface is "installed" when the conflict GATE is present —
 * capture alone (passive telemetry) does not count. `prim claude status`
 * reports the two binaries independently; this gate-only signal is the
 * load-bearing "is the integration wired up?" answer.
 */
export function isGateInstalled(settings: ClaudeSettings): boolean {
  return (settings.hooks?.PreToolUse ?? []).some((e) => entryHasCommand(e, GATE_BIN));
}

export function atomicWrite(path: string, content: ClaudeSettings): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp.${String(Date.now())}`;
  writeFileSync(tmp, `${JSON.stringify(content, null, JSON_INDENT)}\n`, "utf-8");
  // fsync the tmp file before the rename so a crash can't leave a torn
  // settings.json — the rename only ever swaps in fully-flushed bytes.
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

export type ScopeStatus = {
  path: string;
  gate: boolean;
  capture: boolean;
  statusline: boolean;
};

export type InstallResult = {
  scope: Scope;
  path: string;
  gate: boolean;
  capture: boolean;
  statusline: boolean;
  changed: boolean;
};

export function performInstall(scope: Scope, force: boolean): InstallResult {
  const path = settingsPathFor(scope);
  const before = readSettings(path);
  const after = applyInstall(before, { force });
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    atomicWrite(path, after);
  }
  return {
    scope,
    path,
    gate: isGateInstalled(after),
    capture: captureInstalled(after),
    statusline: statuslineInstalled(after),
    changed,
  };
}

export function performUninstall(scope: Scope): InstallResult {
  const path = settingsPathFor(scope);
  const before = readSettings(path);
  const after = applyUninstall(before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    atomicWrite(path, after);
  }
  return {
    scope,
    path,
    gate: isGateInstalled(after),
    capture: captureInstalled(after),
    statusline: statuslineInstalled(after),
    changed,
  };
}

export function performStatus(): { user: ScopeStatus; project: ScopeStatus } {
  const statusFor = (path: string): ScopeStatus => {
    const settings = readSettings(path);
    return {
      path,
      gate: isGateInstalled(settings),
      capture: captureInstalled(settings),
      statusline: statuslineInstalled(settings),
    };
  };
  return { user: statusFor(USER_SCOPE_PATH), project: statusFor(projectScopePath()) };
}

// Default is `project` — a bare `claude install` wires the integration into the
// project you're setting up, not every repo on the machine. `--scope user`
// opts into the machine-global install. Exported so the default is test-pinned.
export function resolveScope(input: string | undefined): Scope {
  if (input === undefined || input === "project") {
    return "project";
  }
  if (input === "user") {
    return "user";
  }
  // Fail loud rather than silently writing the wrong settings.json on a typo.
  console.error(`[prim] unknown --scope "${input}" (expected: user or project)`);
  process.exit(1);
}

export function registerClaudeCommands(program: Command): void {
  const claude = program
    .command("claude")
    .description("Manage the prim Claude Code integration (capture, gate, ingest, presence)");

  claude
    .command("install")
    .description("Register the prim hooks + statusline in Claude Code's settings.json")
    .option(
      "--scope <scope>",
      "project (default, the repo's .claude/settings.json) or user (~/.claude/settings.json)",
    )
    .option("--force", "Replace any drifted prim hook entries")
    .action((opts: { scope?: string; force?: boolean }) => {
      const scope = resolveScope(opts.scope);
      const result = performInstall(scope, opts.force ?? false);
      if (result.changed) {
        console.error(
          `[prim] Claude Code integration installed (${scope} scope) at ${result.path}`,
        );
      } else {
        console.error(
          `[prim] Claude Code integration already present at ${result.path} (no changes)`,
        );
      }
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });

  claude
    .command("uninstall")
    .description("Remove all prim hooks + the prim statusline from settings.json")
    .option(
      "--scope <scope>",
      "project (default, the repo's .claude/settings.json) or user (~/.claude/settings.json)",
    )
    .action((opts: { scope?: string }) => {
      const scope = resolveScope(opts.scope);
      const result = performUninstall(scope);
      if (result.changed) {
        console.error(`[prim] prim hooks removed from ${result.path}`);
      } else {
        console.error(`[prim] no prim hooks to remove at ${result.path} (nothing changed)`);
      }
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });

  claude
    .command("status")
    .description(
      "Report whether each prim surface (gate, capture, statusline) is installed per scope",
    )
    .action(() => {
      const result = performStatus();
      const mark = (b: boolean): string => (b ? "✓" : "✗");
      const line = (label: string, s: ScopeStatus): string =>
        `[prim] ${label}: gate ${mark(s.gate)} · capture ${mark(s.capture)} · statusline ${mark(s.statusline)} (${s.path})`;
      console.error(`${line("user", result.user)}\n${line("project", result.project)}`);
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });
}
