/**
 * `prim claude install|uninstall|status` — manage the prim Claude Code
 * integration in settings.json.
 *
 * One command surface registers BOTH prim binaries Claude Code drives:
 *   - prim-hook (passive capture) at matcher "*" on every hook event, so the
 *     decision journal sees the full session.
 *   - prim-pre-tool-use (the conflict gate) at matcher "Edit|Write|MultiEdit"
 *     on PreToolUse, so edits are checked against the decision graph before
 *     they apply.
 *
 *   prim claude install                 # ~/.claude/settings.json
 *   prim claude install --scope=project # ./.claude/settings.json
 *   prim claude install --force         # replace drifted prim entries
 *   prim claude uninstall               # strip every prim entry
 *   prim claude status                  # report both binaries per scope
 *
 * Merges; never overwrites. Unrelated matchers and non-prim commands are
 * preserved — install only adds/replaces the prim entries, uninstall only
 * removes them. Idempotent. Writes atomically (tmp + fsync + rename) so a
 * crash can never leave a torn settings.json. AX contract: STDOUT is the
 * resulting JSON; STDERR is the human verdict.
 */
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

const CAPTURE_COMMAND = "prim-hook";
const GATE_COMMAND = "prim-pre-tool-use";
const PRIM_COMMANDS = new Set<string>([CAPTURE_COMMAND, GATE_COMMAND]);

const JSON_INDENT = 2;

const USER_SCOPE_PATH = join(homedir(), ".claude", "settings.json");
const PROJECT_SCOPE_PATH = join(process.cwd(), ".claude", "settings.json");

// Capture rides every hook event at the wildcard matcher; the gate rides only
// PreToolUse, scoped to the edit tools it understands. PreToolUse therefore
// carries two prim entries (one per binary), which is intended.
const CAPTURE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "SubagentStop",
] as const;

type Registration = {
  event: string;
  matcher: string;
  command: string;
};

const REGISTRATIONS: Registration[] = [
  ...CAPTURE_EVENTS.map((event) => ({ event, matcher: "*", command: CAPTURE_COMMAND })),
  { event: "PreToolUse", matcher: "Edit|Write|MultiEdit", command: GATE_COMMAND },
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

export type ClaudeSettings = {
  hooks?: Record<string, HookEntry[] | undefined>;
  [key: string]: unknown;
};

function settingsPathFor(scope: Scope): string {
  return scope === "user" ? USER_SCOPE_PATH : PROJECT_SCOPE_PATH;
}

function readSettings(path: string): ClaudeSettings {
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

function entryHasCommand(entry: HookEntry, command: string): boolean {
  return entry.hooks?.some((h) => h.command === command) ?? false;
}

function canonicalEntry(reg: Registration): HookEntry {
  return { matcher: reg.matcher, hooks: [{ type: "command", command: reg.command }] };
}

/**
 * Remove `command` from an event's entry list at HOOK granularity: a hook
 * co-located in a multi-hook entry is stripped without dropping its siblings,
 * and an entry is removed only once its hooks array is empty. This is what
 * keeps a hand-merged `{ hooks: [otherCmd, prim-hook] }` entry's non-prim
 * command alive across install/uninstall.
 */
function stripCommand(list: HookEntry[], command: string): HookEntry[] {
  const out: HookEntry[] = [];
  for (const e of list) {
    const hooks = (e.hooks ?? []).filter((h) => h.command !== command);
    if (hooks.length > 0) {
      out.push({ ...e, hooks });
    }
  }
  return out;
}

/**
 * Ensure one registration's entry is present on its event list. Idempotent: a
 * canonical single-hook entry already in place is a no-op unless `force`. Only
 * THIS command is stripped before the canonical entry is appended, so a
 * sibling prim binary's entry (and any co-located non-prim hook) survives.
 */
function ensureRegistration(list: HookEntry[], reg: Registration, force: boolean): HookEntry[] {
  const hasCanonical = list.some(
    (e) => e.matcher === reg.matcher && e.hooks?.length === 1 && e.hooks[0].command === reg.command,
  );
  if (hasCanonical && !force) {
    return list;
  }
  return [...stripCommand(list, reg.command), canonicalEntry(reg)];
}

export function applyInstall(
  settings: ClaudeSettings,
  options: { force?: boolean } = {},
): ClaudeSettings {
  const hooks: Record<string, HookEntry[] | undefined> = { ...(settings.hooks ?? {}) };
  for (const reg of REGISTRATIONS) {
    hooks[reg.event] = ensureRegistration(hooks[reg.event] ?? [], reg, options.force ?? false);
  }
  return { ...settings, hooks };
}

export function applyUninstall(settings: ClaudeSettings): ClaudeSettings {
  const source = settings.hooks ?? {};
  const hooks: Record<string, HookEntry[] | undefined> = {};
  for (const event of Object.keys(source)) {
    let list = source[event] ?? [];
    for (const command of PRIM_COMMANDS) {
      list = stripCommand(list, command);
    }
    // Events that become empty are dropped entirely (not left as []).
    if (list.length > 0) {
      hooks[event] = list;
    }
  }
  return { ...settings, hooks };
}

function captureInstalled(settings: ClaudeSettings): boolean {
  return CAPTURE_EVENTS.some((event) =>
    (settings.hooks?.[event] ?? []).some((e) => entryHasCommand(e, CAPTURE_COMMAND)),
  );
}

/**
 * The unified surface is "installed" when the conflict GATE is present —
 * capture alone (passive telemetry) does not count. `prim claude status`
 * reports the two binaries independently; this gate-only signal is the
 * load-bearing "is the integration wired up?" answer.
 */
export function isGateInstalled(settings: ClaudeSettings): boolean {
  return (settings.hooks?.PreToolUse ?? []).some((e) => entryHasCommand(e, GATE_COMMAND));
}

function atomicWrite(path: string, content: ClaudeSettings): void {
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
};

export type InstallResult = {
  scope: Scope;
  path: string;
  gate: boolean;
  capture: boolean;
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
    changed,
  };
}

export function performStatus(): { user: ScopeStatus; project: ScopeStatus } {
  const statusFor = (path: string): ScopeStatus => {
    const settings = readSettings(path);
    return { path, gate: isGateInstalled(settings), capture: captureInstalled(settings) };
  };
  return { user: statusFor(USER_SCOPE_PATH), project: statusFor(PROJECT_SCOPE_PATH) };
}

function resolveScope(input: string | undefined): Scope {
  if (input === undefined || input === "user") {
    return "user";
  }
  if (input === "project") {
    return "project";
  }
  // Fail loud rather than silently writing the wrong settings.json on a typo.
  console.error(`[prim] unknown --scope "${input}" (expected: user or project)`);
  process.exit(1);
}

export function registerClaudeCommands(program: Command): void {
  const claude = program
    .command("claude")
    .description("Manage the prim Claude Code integration (capture + conflict gate)");

  claude
    .command("install")
    .description("Register the prim capture + PreToolUse gate hooks in Claude Code's settings.json")
    .option(
      "--scope <scope>",
      "user (default, ~/.claude/settings.json) or project (./.claude/settings.json)",
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
    .description("Remove all prim hooks (capture + gate) from settings.json")
    .option(
      "--scope <scope>",
      "user (default, ~/.claude/settings.json) or project (./.claude/settings.json)",
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
    .description("Report whether the prim capture + gate hooks are installed per scope")
    .action(() => {
      const result = performStatus();
      const line = (label: string, s: ScopeStatus): string =>
        `[prim] ${label}: gate ${s.gate ? "✓" : "✗"} · capture ${s.capture ? "✓" : "✗"} (${s.path})`;
      console.error(`${line("user", result.user)}\n${line("project", result.project)}`);
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });
}
