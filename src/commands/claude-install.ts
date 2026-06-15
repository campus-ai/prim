/**
 * Decision Event Pipeline — Claude Code hook installer.
 *
 *   prim claude-install            (preview the snippet)
 *   prim claude-install --apply    (merge into ~/.claude/settings.json)
 *
 * Merges; never overwrites. Existing hook entries with non-`prim-hook`
 * commands are preserved. If `prim-hook` is already present for an event,
 * we no-op for that event (idempotent re-runs).
 *
 * Writes atomically via tmp-file + rename — settings.json cannot be
 * corrupted mid-write.
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

const SETTINGS_PATH = join(homedir(), ".claude", "settings.json");
const JSON_INDENT = 2;

const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PreToolUse",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "SubagentStop",
] as const;

type HookEntry = {
  matcher?: string;
  hooks: Array<{ type: string; command: string }>;
};

type Settings = {
  hooks?: Record<string, HookEntry[]>;
  [key: string]: unknown;
};

const PRIM_ENTRY: HookEntry = {
  matcher: "*",
  hooks: [{ type: "command", command: "prim-hook" }],
};

function readSettings(): Settings {
  if (!existsSync(SETTINGS_PATH)) {
    return {};
  }
  const raw = readFileSync(SETTINGS_PATH, "utf-8");
  try {
    return JSON.parse(raw) as Settings;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`${SETTINGS_PATH} is not valid JSON: ${detail}`);
  }
}

function alreadyInstalled(list: HookEntry[]): boolean {
  return list.some(
    (entry) => Array.isArray(entry.hooks) && entry.hooks.some((h) => h.command === "prim-hook"),
  );
}

function mergeHooks(settings: Settings): Settings {
  const next: Settings = { ...settings };
  const hooks: Record<string, HookEntry[]> = { ...(next.hooks ?? {}) };
  for (const event of HOOK_EVENTS) {
    const list = hooks[event] ?? [];
    if (alreadyInstalled(list)) {
      continue;
    }
    hooks[event] = [...list, PRIM_ENTRY];
  }
  next.hooks = hooks;
  return next;
}

function atomicWrite(content: Settings): void {
  const dir = dirname(SETTINGS_PATH);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${SETTINGS_PATH}.tmp.${String(Date.now())}`;
  writeFileSync(tmp, `${JSON.stringify(content, null, JSON_INDENT)}\n`, "utf-8");
  // fsync the tmp file before the rename so a crash can't leave a torn
  // settings.json — the rename only ever swaps in fully-flushed bytes.
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, SETTINGS_PATH);
}

export function registerClaudeInstallCommands(program: Command): void {
  program
    .command("claude-install")
    .description("Install prim-hook into ~/.claude/settings.json for all Decision Event hooks")
    .option("--apply", "write changes to ~/.claude/settings.json")
    .action((opts: { apply?: boolean }) => {
      const current = readSettings();
      const next = mergeHooks(current);
      if (opts.apply) {
        atomicWrite(next);
        console.log(
          `[prim] installed prim-hook for ${String(HOOK_EVENTS.length)} hook events in ${SETTINGS_PATH}`,
        );
      } else {
        console.log("# preview — pass --apply to write");
        console.log(JSON.stringify({ hooks: next.hooks }, null, JSON_INDENT));
      }
    });
}
