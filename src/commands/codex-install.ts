/**
 * `prim codex install|uninstall|status` — manage the prim Codex integration
 * in ~/.codex/hooks.json.
 *
 * Codex's hook config shape is identical to Claude Code's nested
 * { hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }, so this
 * reuses the merge engine from claude-install.ts (readSettings,
 * ensureRegistration, stripCommand, atomicWrite) rather than duplicating it —
 * only the registration table, the target file, and the absent surfaces differ.
 *
 * It drives the same prim binaries Claude Code does, under `--agent codex`:
 *   - prim-hook (passive capture) at matcher "*" on every Codex hook event, so
 *     the decision journal sees the full session.
 *   - prim-pre-tool-use (the conflict gate) and prim-post-tool-use (server move
 *     ingest + verdict footer) on `apply_patch`, Codex's edit tool.
 *   - prim-session-start on SessionStart, so the daemon's presence reflects it.
 *
 * Codex divergences from the Claude surface:
 *   - the target is ~/.codex/hooks.json (a dedicated hooks file; no statusLine).
 *   - the edit tool is `apply_patch`, so the gate/ingest hooks match it (not
 *     Edit|Write|MultiEdit).
 *   - no SessionEnd (Codex fires no such event) and no statusLine (Codex has no
 *     statusLine hook — SessionStart developer-context is the analog).
 *   - Codex requires `/hooks` trust review before non-managed hooks fire.
 *
 * AX contract (matches `prim claude`): STDOUT is the JSON result; STDERR is the
 * human verdict.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import {
  type ClaudeSettings,
  type HookEntry,
  type Registration,
  type Scope,
  atomicWrite,
  ensureRegistration,
  entryHasCommand,
  readSettings,
  stripCommand,
} from "./claude-install.js";

const CAPTURE_COMMAND = "prim-hook --agent codex";
const GATE_COMMAND = "prim-pre-tool-use --agent codex";
const POST_TOOL_USE_COMMAND = "prim-post-tool-use --agent codex";
const SESSION_START_COMMAND = "prim-session-start --agent codex";
const JSON_INDENT = 2;

// The Codex hook events capture rides. Mirrors the Claude capture set minus
// SessionEnd (Codex has no such event).
const CODEX_CAPTURE_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SubagentStop",
] as const;

const PRIM_COMMANDS = new Set<string>([
  CAPTURE_COMMAND,
  GATE_COMMAND,
  POST_TOOL_USE_COMMAND,
  SESSION_START_COMMAND,
]);

// Mirror of claude-install's REGISTRATIONS, retargeted to Codex: capture on
// every event at the wildcard matcher; the gate and the PostToolUse ingest hook
// ride `apply_patch`; session-start notifies the daemon. PreToolUse and
// PostToolUse each carry two prim entries (capture + their dedicated hook),
// which is intended.
const CODEX_REGISTRATIONS: Registration[] = [
  ...CODEX_CAPTURE_EVENTS.map((event) => ({ event, matcher: "*", command: CAPTURE_COMMAND })),
  { event: "PreToolUse", matcher: "apply_patch", command: GATE_COMMAND },
  { event: "PostToolUse", matcher: "apply_patch", command: POST_TOOL_USE_COMMAND },
  { event: "SessionStart", matcher: "*", command: SESSION_START_COMMAND },
];

const USER_SCOPE_PATH = join(homedir(), ".codex", "hooks.json");
const PROJECT_SCOPE_PATH = join(process.cwd(), ".codex", "hooks.json");

function settingsPathFor(scope: Scope): string {
  return scope === "user" ? USER_SCOPE_PATH : PROJECT_SCOPE_PATH;
}

export function applyInstall(
  settings: ClaudeSettings,
  options: { force?: boolean } = {},
): ClaudeSettings {
  const hooks: Record<string, HookEntry[] | undefined> = { ...(settings.hooks ?? {}) };
  for (const reg of CODEX_REGISTRATIONS) {
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
  return CODEX_CAPTURE_EVENTS.some((event) =>
    (settings.hooks?.[event] ?? []).some((e) => entryHasCommand(e, CAPTURE_COMMAND)),
  );
}

/**
 * The Codex surface is "installed" when the conflict GATE is present — capture
 * alone (passive telemetry) does not count. Mirrors `prim claude status`.
 */
export function isGateInstalled(settings: ClaudeSettings): boolean {
  return (settings.hooks?.PreToolUse ?? []).some((e) => entryHasCommand(e, GATE_COMMAND));
}

export type ScopeStatus = { path: string; gate: boolean; capture: boolean };

export type InstallResult = {
  scope: Scope;
  path: string;
  gate: boolean;
  capture: boolean;
  changed: boolean;
};

function resultFor(
  scope: Scope,
  path: string,
  after: ClaudeSettings,
  changed: boolean,
): InstallResult {
  return {
    scope,
    path,
    gate: isGateInstalled(after),
    capture: captureInstalled(after),
    changed,
  };
}

export function performInstall(scope: Scope, force: boolean): InstallResult {
  const path = settingsPathFor(scope);
  const before = readSettings(path);
  const after = applyInstall(before, { force });
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    atomicWrite(path, after);
  }
  return resultFor(scope, path, after, changed);
}

export function performUninstall(scope: Scope): InstallResult {
  const path = settingsPathFor(scope);
  const before = readSettings(path);
  const after = applyUninstall(before);
  const changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) {
    atomicWrite(path, after);
  }
  return resultFor(scope, path, after, changed);
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
  // Fail loud rather than silently writing the wrong hooks.json on a typo.
  console.error(`[prim] unknown --scope "${input}" (expected: user or project)`);
  process.exit(1);
}

const TRUST_NOTICE =
  "[prim] Codex requires hook trust: run `/hooks` in Codex to review and trust these hooks " +
  "(or start Codex with --dangerously-bypass-hook-trust). Until trusted, the hooks will not fire.";

export function registerCodexCommands(program: Command): void {
  const codex = program
    .command("codex")
    .description("Manage the prim Codex integration (capture, gate, ingest, presence)");

  codex
    .command("install")
    .description("Register the prim hooks in Codex's ~/.codex/hooks.json")
    .option(
      "--scope <scope>",
      "user (default, ~/.codex/hooks.json) or project (./.codex/hooks.json)",
    )
    .option("--force", "Replace any drifted prim hook entries")
    .action((opts: { scope?: string; force?: boolean }) => {
      const scope = resolveScope(opts.scope);
      const result = performInstall(scope, opts.force ?? false);
      if (result.changed) {
        console.error(`[prim] Codex integration installed (${scope} scope) at ${result.path}`);
      } else {
        console.error(`[prim] Codex integration already present at ${result.path} (no changes)`);
      }
      console.error(TRUST_NOTICE);
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });

  codex
    .command("uninstall")
    .description("Remove all prim hooks from ~/.codex/hooks.json")
    .option(
      "--scope <scope>",
      "user (default, ~/.codex/hooks.json) or project (./.codex/hooks.json)",
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

  codex
    .command("status")
    .description("Report whether each prim surface (gate, capture) is installed per scope")
    .action(() => {
      const result = performStatus();
      const mark = (b: boolean): string => (b ? "✓" : "✗");
      const line = (label: string, s: ScopeStatus): string =>
        `[prim] ${label}: gate ${mark(s.gate)} · capture ${mark(s.capture)} (${s.path})`;
      console.error(`${line("user", result.user)}\n${line("project", result.project)}`);
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });
}
