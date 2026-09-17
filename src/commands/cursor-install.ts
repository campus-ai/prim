/** Manage Primitive's native Cursor hook and Cursor CLI footer integration. */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { Command } from "commander";
import { atomicWriteFile } from "../lib/atomic-file.js";
import {
  type HookCommandResolution,
  hookCommandResolutions,
  stableHookCommand,
} from "../lib/bin-path.js";
import { stageHookRuntime } from "../lib/hook-runtime.js";
import { type Scope, projectRoot } from "./claude-install.js";

const CAPTURE_BIN = "prim-hook";
const GATE_BIN = "prim-pre-tool-use";
const POST_TOOL_BIN = "prim-post-tool-use";
const SESSION_START_BIN = "prim-session-start";
const SESSION_END_BIN = "prim-session-end";
const STATUSLINE_BIN = "prim-statusline";
const PRIM_BINS = [CAPTURE_BIN, GATE_BIN, POST_TOOL_BIN, SESSION_START_BIN, SESSION_END_BIN];
const CURSOR_EVENTS = [
  "sessionStart",
  "beforeSubmitPrompt",
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "afterAgentResponse",
  "subagentStop",
  "stop",
  "sessionEnd",
] as const;
export type CursorEvent = (typeof CURSOR_EVENTS)[number];

export type CursorHook = {
  command: string;
  matcher?: string;
  timeout?: number;
  [key: string]: unknown;
};

export type CursorHooksSettings = {
  version?: number;
  hooks?: Record<string, CursorHook[]>;
  [key: string]: unknown;
};

type CursorRegistration = {
  event: CursorEvent;
  bin: string;
  matcher?: string;
  timeout?: number;
};

const REGISTRATIONS: readonly CursorRegistration[] = [
  ...CURSOR_EVENTS.map((event) => ({ event, bin: CAPTURE_BIN })),
  { event: "preToolUse", bin: GATE_BIN, matcher: "Write|Delete|Shell", timeout: 10 },
  { event: "postToolUse", bin: POST_TOOL_BIN },
  { event: "postToolUseFailure", bin: POST_TOOL_BIN },
  { event: "sessionStart", bin: SESSION_START_BIN },
  { event: "sessionEnd", bin: SESSION_END_BIN },
];

export function cursorConfigDirectory(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  platform: NodeJS.Platform = process.platform,
): string {
  const explicit = env.CURSOR_CONFIG_DIR?.trim();
  if (explicit && isAbsolute(explicit)) return explicit;
  const xdg = env.XDG_CONFIG_HOME?.trim();
  if (platform !== "darwin" && xdg && isAbsolute(xdg)) return join(xdg, "cursor");
  return join(home, ".cursor");
}

export function cursorHooksPath(scope: Scope, root = projectRoot()): string {
  return scope === "user"
    ? join(cursorConfigDirectory(), "hooks.json")
    : join(root, ".cursor", "hooks.json");
}

export function cursorCliConfigPath(): string {
  return join(cursorConfigDirectory(), "cli-config.json");
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readCursorHooks(path: string): CursorHooksSettings {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`invalid Cursor hooks JSON at ${path}`);
  }
  if (!plainObject(parsed)) throw new Error(`Cursor hooks config must be an object: ${path}`);
  if (parsed.version !== undefined && parsed.version !== 1) {
    throw new Error(`unsupported Cursor hooks version at ${path} (expected version 1)`);
  }
  if (parsed.hooks !== undefined) {
    if (!plainObject(parsed.hooks)) throw new Error(`Cursor hooks must be an object: ${path}`);
    for (const [event, entries] of Object.entries(parsed.hooks)) {
      if (!Array.isArray(entries) || !entries.every(plainObject)) {
        throw new Error(`Cursor hook list must contain objects: ${event} in ${path}`);
      }
    }
  }
  return parsed as CursorHooksSettings;
}

function readObject(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    throw new Error(`invalid Cursor CLI config JSON at ${path}`);
  }
  if (!plainObject(parsed)) throw new Error(`Cursor CLI config must be an object: ${path}`);
  return parsed;
}

function writeJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`, { ensureParent: true });
}

function commandFor(registration: CursorRegistration, scope: Scope): string {
  return stableHookCommand(
    registration.bin,
    `--agent cursor --event ${registration.event} --scope ${scope}`,
  );
}

const OWNED_COMMANDS = new Set(
  (["project", "user"] as const).flatMap((scope) =>
    REGISTRATIONS.map((registration) => commandFor(registration, scope)),
  ),
);

export function isOwnedCursorHookCommand(command: unknown): command is string {
  return typeof command === "string" && OWNED_COMMANDS.has(command);
}

function hookFor(registration: CursorRegistration, scope: Scope): CursorHook {
  return {
    command: commandFor(registration, scope),
    ...(registration.matcher ? { matcher: registration.matcher } : {}),
    ...(registration.timeout ? { timeout: registration.timeout } : {}),
  };
}

function exactHook(entry: CursorHook, registration: CursorRegistration, scope: Scope): boolean {
  return JSON.stringify(entry) === JSON.stringify(hookFor(registration, scope));
}

export function applyCursorInstall(
  settings: CursorHooksSettings,
  scope: Scope,
): CursorHooksSettings {
  const hooks: Record<string, CursorHook[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    hooks[event] = entries.filter((entry) => !isOwnedCursorHookCommand(entry.command));
  }
  for (const registration of REGISTRATIONS) {
    const entries = hooks[registration.event] ?? [];
    entries.push(hookFor(registration, scope));
    hooks[registration.event] = entries;
  }
  return { ...settings, version: 1, hooks };
}

export function applyCursorUninstall(settings: CursorHooksSettings): CursorHooksSettings {
  const hooks: Record<string, CursorHook[]> = {};
  for (const [event, entries] of Object.entries(settings.hooks ?? {})) {
    const retained = entries.filter((entry) => !isOwnedCursorHookCommand(entry.command));
    if (retained.length > 0) hooks[event] = retained;
  }
  return { ...settings, hooks };
}

function ownedEntries(settings: CursorHooksSettings): Array<{ event: string; entry: CursorHook }> {
  return Object.entries(settings.hooks ?? {}).flatMap(([event, entries]) =>
    entries
      .filter((entry) => isOwnedCursorHookCommand(entry.command))
      .map((entry) => ({ event, entry })),
  );
}

export function hasExactCursorHandler(
  settings: CursorHooksSettings,
  event: string,
  bin: string,
  scope: Scope,
): boolean {
  const registration = REGISTRATIONS.find(
    (candidate) => candidate.event === event && candidate.bin === bin,
  );
  return registration
    ? (settings.hooks?.[event] ?? []).some((entry) => exactHook(entry, registration, scope))
    : false;
}

function complete(settings: CursorHooksSettings, scope: Scope): boolean {
  const owned = ownedEntries(settings);
  return (
    owned.length === REGISTRATIONS.length &&
    REGISTRATIONS.every(
      (registration) =>
        owned.filter(
          ({ event, entry }) =>
            event === registration.event && exactHook(entry, registration, scope),
        ).length === 1,
    )
  );
}

function captureInstalled(settings: CursorHooksSettings, scope: Scope): boolean {
  return CURSOR_EVENTS.every((event) => hasExactCursorHandler(settings, event, CAPTURE_BIN, scope));
}

function gateInstalled(settings: CursorHooksSettings, scope: Scope): boolean {
  return hasExactCursorHandler(settings, "preToolUse", GATE_BIN, scope);
}

const FOOTER = {
  type: "command",
  command: stableHookCommand(STATUSLINE_BIN),
  updateIntervalMs: 1_000,
  timeoutMs: 2_000,
} as const;

function exactFooter(value: unknown): boolean {
  return plainObject(value) && JSON.stringify(value) === JSON.stringify(FOOTER);
}

export function applyCursorFooterInstall(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  installed: boolean;
  preservedCustom: boolean;
} {
  if (config.statusLine === undefined)
    return { config: { ...config, statusLine: FOOTER }, installed: true, preservedCustom: false };
  if (exactFooter(config.statusLine)) return { config, installed: true, preservedCustom: false };
  return { config, installed: false, preservedCustom: true };
}

export function applyCursorFooterUninstall(config: Record<string, unknown>): {
  config: Record<string, unknown>;
  removed: boolean;
} {
  if (!exactFooter(config.statusLine)) return { config, removed: false };
  return {
    config: Object.fromEntries(Object.entries(config).filter(([key]) => key !== "statusLine")),
    removed: true,
  };
}

export type CursorScopeStatus = {
  path: string;
  present: boolean;
  gate: boolean;
  capture: boolean;
  complete: boolean;
  footer?: boolean;
  footerPreservedCustom?: boolean;
};

export type CursorInstallResult = CursorScopeStatus & {
  scope: Scope;
  changed: boolean;
  restartRequired: boolean;
};

function statusFor(scope: Scope, path = cursorHooksPath(scope)): CursorScopeStatus {
  const settings = readCursorHooks(path);
  const base: CursorScopeStatus = {
    path,
    present: ownedEntries(settings).length > 0,
    gate: gateInstalled(settings, scope),
    capture: captureInstalled(settings, scope),
    complete: complete(settings, scope),
  };
  if (scope === "user") {
    const cliConfig = readObject(cursorCliConfigPath());
    base.footer = exactFooter(cliConfig.statusLine);
    base.footerPreservedCustom = cliConfig.statusLine !== undefined && !base.footer;
  }
  return base;
}

export function performInstall(scope: Scope, _force = false): CursorInstallResult {
  stageHookRuntime();
  const path = cursorHooksPath(scope);
  const before = readCursorHooks(path);
  const after = applyCursorInstall(before, scope);
  let changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) writeJson(path, after);
  let restartRequired = false;
  if (scope === "user") {
    const cliPath = cursorCliConfigPath();
    const cliBefore = readObject(cliPath);
    const footer = applyCursorFooterInstall(cliBefore);
    if (JSON.stringify(cliBefore) !== JSON.stringify(footer.config)) {
      writeJson(cliPath, footer.config);
      changed = true;
      restartRequired = true;
    }
  }
  return { scope, ...statusFor(scope, path), changed, restartRequired };
}

export function performUninstall(scope: Scope): CursorInstallResult {
  const path = cursorHooksPath(scope);
  const before = readCursorHooks(path);
  const after = applyCursorUninstall(before);
  let changed = JSON.stringify(before) !== JSON.stringify(after);
  if (changed) writeJson(path, after);
  let restartRequired = false;
  if (scope === "user") {
    const cliPath = cursorCliConfigPath();
    const cliBefore = readObject(cliPath);
    const footer = applyCursorFooterUninstall(cliBefore);
    if (footer.removed) {
      writeJson(cliPath, footer.config);
      changed = true;
      restartRequired = true;
    }
  }
  return { scope, ...statusFor(scope, path), changed, restartRequired };
}

export function performStatus(): { user: CursorScopeStatus; project: CursorScopeStatus } {
  return { user: statusFor("user"), project: statusFor("project") };
}

export function inspectHookRuntimeResolutions(): HookCommandResolution[] {
  const commands = (["user", "project"] as const).flatMap((scope) =>
    ownedEntries(readCursorHooks(cursorHooksPath(scope))).map(({ entry }) => entry.command),
  );
  return hookCommandResolutions(commands, PRIM_BINS);
}

export function resolveScope(input: string | undefined): Scope {
  if (input === undefined || input === "project") return "project";
  if (input === "user") return "user";
  throw new Error(`unknown --scope "${input}" (expected: user or project)`);
}

export function registerCursorCommands(program: Command): void {
  const cursor = program
    .command("cursor")
    .description("Manage the native Cursor integration (capture, gate, ingest, presence)");
  cursor
    .command("install")
    .description("Register Primitive in Cursor's native hooks.json")
    .option("--scope <scope>", "project (default) or user")
    .option("--force", "Repair drifted Primitive entries; custom Cursor fields remain untouched")
    .action((opts: { scope?: string; force?: boolean }) => {
      const result = performInstall(resolveScope(opts.scope), opts.force);
      console.error(
        result.changed
          ? `[prim] Cursor integration installed (${result.scope} scope) at ${result.path}`
          : `[prim] Cursor integration already present at ${result.path}`,
      );
      if (result.restartRequired) console.error("[prim] restart Cursor CLI to load the footer");
      console.log(JSON.stringify(result, null, 2));
    });
  cursor
    .command("uninstall")
    .description("Remove only Primitive-owned Cursor hooks and footer")
    .option("--scope <scope>", "project (default) or user")
    .action((opts: { scope?: string }) => {
      const result = performUninstall(resolveScope(opts.scope));
      console.error(
        result.changed
          ? `[prim] Cursor integration removed (${result.scope} scope)`
          : `[prim] no Primitive-owned Cursor integration found (${result.scope} scope)`,
      );
      if (result.restartRequired) console.error("[prim] restart Cursor CLI to remove the footer");
      console.log(JSON.stringify(result, null, 2));
    });
  cursor
    .command("status")
    .description("Report native Cursor hook and footer status")
    .action(() => {
      const result = performStatus();
      const mark = (value: boolean | undefined): string => (value ? "✓" : "✗");
      console.error(
        `[prim] user: gate ${mark(result.user.gate)} · capture ${mark(result.user.capture)} · footer ${mark(result.user.footer)} (${result.user.path})\n` +
          `[prim] project: gate ${mark(result.project.gate)} · capture ${mark(result.project.capture)} (${result.project.path})`,
      );
      console.log(JSON.stringify(result, null, 2));
    });
}
