/**
 * `prim hermes install|uninstall|status` — manage the prim Hermes Agent
 * integration in `~/.hermes/config.yaml`.
 *
 * Hermes reads shell hooks ONLY from this global file (there is no repo-local
 * Hermes config), so the integration is necessarily user-scoped and gated to
 * prim-bound repos at hook time by cwd — the same way the capture pipeline
 * already binds moves to an org. `--scope project` is a hard error rather than
 * a silent global write.
 *
 * It drives the same prim binaries Claude Code and Codex do, under
 * `--agent hermes`:
 *   - prim-hook (capture) on every Hermes lifecycle event prim observes.
 *   - prim-pre-tool-use (gate) and prim-post-tool-use (ingest) on Hermes's
 *     edit tools, matched by the regex `write_file|patch`.
 *   - prim-session-start / prim-session-end on the session boundaries, so the
 *     daemon's presence reflects live Hermes sessions.
 *
 * Two divergences from the Claude/Codex installers shape this module:
 *   1. The target is YAML, not JSON. We parse it as a document and rewrite ONLY
 *      its top-level `hooks` key, so the user's providers, models, and other
 *      config survive a prim install/uninstall untouched.
 *   2. Hermes executes hook commands with `shell=False` (shlex.split), so the
 *      shell-string resolution shim the Claude/Codex installs write would be
 *      exec'd as a literal program. Instead we install one small executable
 *      shim script (`~/.hermes/agent-hooks/prim-shim.sh`) that does the
 *      PATH → local → npx@latest resolution, and point each hook command at it.
 *
 * Writes atomically (tmp + fsync + rename). AX contract (matches `prim claude`
 * / `prim codex`): STDOUT is the JSON result; STDERR is the human verdict.
 */
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Command } from "commander";
import { Document, parseDocument } from "yaml";

const CAPTURE_BIN = "prim-hook";
const GATE_BIN = "prim-pre-tool-use";
const POST_TOOL_USE_BIN = "prim-post-tool-use";
const SESSION_START_BIN = "prim-session-start";
const SESSION_END_BIN = "prim-session-end";
const HERMES_ARGS = "--agent hermes";
const EDIT_MATCHER = "write_file|patch";
const JSON_INDENT = 2;
const SHIM_MODE = 0o755;

const PRIM_BINS: readonly string[] = [
  CAPTURE_BIN,
  GATE_BIN,
  POST_TOOL_USE_BIN,
  SESSION_START_BIN,
  SESSION_END_BIN,
];

// HERMES_HOME defaults to ~/.hermes; honor it so a relocated Hermes is found.
function hermesHome(): string {
  return process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}
function configPath(): string {
  return join(hermesHome(), "config.yaml");
}
function shimPath(): string {
  return join(hermesHome(), "agent-hooks", "prim-shim.sh");
}

// The executable that stands in for the shell resolution Hermes' shell=False
// model can't do inline: resolve the prim bin in $1 (PATH → local → npx@latest)
// and exec it with the rest of the args, passing stdin/stdout/exit through.
const SHIM_SCRIPT = `#!/bin/sh
# prim Hermes hook shim — managed by \`prim hermes install\`. Hermes runs hooks
# with shell=False, so the PATH → local node_modules → npx @latest resolution a
# shell does for the Claude Code / Codex installs lives here instead.
bin="$1"
shift
if command -v "$bin" >/dev/null 2>&1; then
  exec "$bin" "$@"
fi
if [ -x "./node_modules/.bin/$bin" ]; then
  exec "./node_modules/.bin/$bin" "$@"
fi
exec npx --yes -p @primitive.ai/prim@latest "$bin" "$@"
`;

function commandFor(bin: string): string {
  return `${shimPath()} ${bin} ${HERMES_ARGS}`;
}

// A hook command is prim's when it routes `bin` through the prim shim. The
// shim name + bin token is stable regardless of the (machine-specific) home
// prefix, and the five bin names are mutually non-substring.
function commandUsesBin(command: string, bin: string): boolean {
  return command.includes(`prim-shim.sh ${bin} `);
}

// The Hermes lifecycle events the capture hook rides — the Hermes-named
// analogs of Claude's CAPTURE_EVENTS.
const CAPTURE_EVENTS = [
  "on_session_start",
  "pre_llm_call",
  "pre_tool_call",
  "post_tool_call",
  "post_llm_call",
  "on_session_end",
  "subagent_stop",
] as const;

type HermesReg = { event: string; matcher?: string; bin: string };

// Capture on every observed event; the gate/ingest on the edit tools; the
// session hooks on the boundaries. pre_tool_call and post_tool_call each carry
// two prim entries (capture + their dedicated hook), as on Claude/Codex.
const REGISTRATIONS: HermesReg[] = [
  ...CAPTURE_EVENTS.map((event) => ({ event, bin: CAPTURE_BIN })),
  { event: "pre_tool_call", matcher: EDIT_MATCHER, bin: GATE_BIN },
  { event: "post_tool_call", matcher: EDIT_MATCHER, bin: POST_TOOL_USE_BIN },
  { event: "on_session_start", bin: SESSION_START_BIN },
  { event: "on_session_end", bin: SESSION_END_BIN },
];

export type HookEntry = { matcher?: string; command: string; timeout?: number };
export type HooksMap = Record<string, HookEntry[]>;

function entryFor(reg: HermesReg): HookEntry {
  const command = commandFor(reg.bin);
  return reg.matcher ? { matcher: reg.matcher, command } : { command };
}

// Strip every entry whose command routes through `bin`, leaving co-located
// non-prim hooks under the same event intact.
export function stripBin(list: HookEntry[], bin: string): HookEntry[] {
  return list.filter((e) => !commandUsesBin(e.command, bin));
}

export function ensureReg(list: HookEntry[], reg: HermesReg, force: boolean): HookEntry[] {
  const entry = entryFor(reg);
  const present = list.some(
    (e) => e.command === entry.command && (e.matcher ?? "") === (entry.matcher ?? ""),
  );
  if (present && !force) {
    return list;
  }
  return [...stripBin(list, reg.bin), entry];
}

export function applyInstall(hooks: HooksMap, force: boolean): HooksMap {
  const next: HooksMap = { ...hooks };
  for (const reg of REGISTRATIONS) {
    next[reg.event] = ensureReg(next[reg.event] ?? [], reg, force);
  }
  return next;
}

export function applyUninstall(hooks: HooksMap): HooksMap {
  const next: HooksMap = {};
  for (const [event, list] of Object.entries(hooks)) {
    let kept = list;
    for (const bin of PRIM_BINS) {
      kept = stripBin(kept, bin);
    }
    if (kept.length > 0) {
      next[event] = kept;
    }
  }
  return next;
}

export function isGateInstalled(hooks: HooksMap): boolean {
  return (hooks.pre_tool_call ?? []).some((e) => commandUsesBin(e.command, GATE_BIN));
}

export function isCaptureInstalled(hooks: HooksMap): boolean {
  return CAPTURE_EVENTS.some((event) =>
    (hooks[event] ?? []).some((e) => commandUsesBin(e.command, CAPTURE_BIN)),
  );
}

// Parse the document, preserving everything outside `hooks`. A missing or empty
// file yields a fresh document.
function readDoc(path: string): Document {
  if (!existsSync(path)) {
    return new Document();
  }
  const raw = readFileSync(path, "utf-8");
  return raw.trim().length === 0 ? new Document() : parseDocument(raw);
}

export function readHooks(doc: Document): HooksMap {
  const root = doc.toJS() as Record<string, unknown> | null;
  const hooks = root?.hooks;
  if (!hooks || typeof hooks !== "object" || Array.isArray(hooks)) {
    return {};
  }
  const out: HooksMap = {};
  for (const [event, list] of Object.entries(hooks as Record<string, unknown>)) {
    if (!Array.isArray(list)) {
      continue;
    }
    const entries = list.filter(
      (e): e is HookEntry =>
        typeof e === "object" && e !== null && typeof (e as HookEntry).command === "string",
    );
    if (entries.length > 0) {
      out[event] = entries;
    }
  }
  return out;
}

function writeHooks(doc: Document, hooks: HooksMap): void {
  if (Object.keys(hooks).length === 0) {
    doc.delete("hooks");
  } else {
    doc.set("hooks", hooks);
  }
}

function atomicWriteFile(path: string, content: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  const tmp = `${path}.tmp.${String(process.pid)}`;
  writeFileSync(tmp, content, "utf-8");
  const fd = openSync(tmp, "r+");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
}

function writeShim(): void {
  const path = shimPath();
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, SHIM_SCRIPT, "utf-8");
  chmodSync(path, SHIM_MODE);
}

function removeShim(): void {
  rmSync(shimPath(), { force: true });
}

function autoAcceptOf(doc: Document): boolean {
  return (doc.toJS() as Record<string, unknown> | null)?.hooks_auto_accept === true;
}

export type InstallResult = {
  path: string;
  gate: boolean;
  capture: boolean;
  autoAccept: boolean;
  changed: boolean;
};

export function performInstall(opts: { force: boolean; autoAccept: boolean }): InstallResult {
  const path = configPath();
  const doc = readDoc(path);
  const before = doc.toString();
  writeHooks(doc, applyInstall(readHooks(doc), opts.force));
  if (opts.autoAccept) {
    doc.set("hooks_auto_accept", true);
  }
  const after = doc.toString();
  const changed = before !== after;
  // The shim is what the hook commands point at; write it whenever installing,
  // idempotently, so a config-unchanged re-install still heals a missing shim.
  writeShim();
  if (changed) {
    atomicWriteFile(path, after);
  }
  const hooks = readHooks(doc);
  return {
    path,
    gate: isGateInstalled(hooks),
    capture: isCaptureInstalled(hooks),
    autoAccept: autoAcceptOf(doc),
    changed,
  };
}

export function performUninstall(): InstallResult {
  const path = configPath();
  if (!existsSync(path)) {
    removeShim();
    return { path, gate: false, capture: false, autoAccept: false, changed: false };
  }
  const doc = readDoc(path);
  const before = doc.toString();
  writeHooks(doc, applyUninstall(readHooks(doc)));
  const after = doc.toString();
  const changed = before !== after;
  if (changed) {
    atomicWriteFile(path, after);
  }
  // Every prim hook is gone now, so the shim it routed through is unused.
  removeShim();
  const hooks = readHooks(doc);
  return {
    path,
    gate: isGateInstalled(hooks),
    capture: isCaptureInstalled(hooks),
    autoAccept: autoAcceptOf(doc),
    changed,
  };
}

export function performStatus(): { path: string; gate: boolean; capture: boolean } {
  const path = configPath();
  const hooks = existsSync(path) ? readHooks(readDoc(path)) : {};
  return { path, gate: isGateInstalled(hooks), capture: isCaptureInstalled(hooks) };
}

const TRUST_NOTICE =
  "[prim] Hermes requires hook consent: it prompts once per (event, command) on a TTY and " +
  "records approval in ~/.hermes/shell-hooks-allowlist.json. To pre-approve non-interactively, " +
  "re-run with --auto-accept (sets hooks_auto_accept: true), export HERMES_ACCEPT_HOOKS=1, or " +
  "start Hermes with `hermes --accept-hooks chat`. Until approved, the hooks will not fire.";

// Hermes config is global-only; reject an explicit project scope rather than
// silently writing the machine-global file.
function rejectProjectScope(scope: string | undefined): void {
  if (scope === "project") {
    console.error(
      "[prim] Hermes config is global-only (~/.hermes/config.yaml); --scope project is not supported.",
    );
    process.exit(2);
  }
}

export function registerHermesCommands(program: Command): void {
  const hermes = program
    .command("hermes")
    .description("Manage the prim Hermes Agent integration (capture, gate, ingest, presence)");

  hermes
    .command("install")
    .description("Register the prim hooks in Hermes's ~/.hermes/config.yaml")
    .option("--scope <scope>", "user (default; Hermes config is global-only)")
    .option("--force", "Replace any drifted prim hook entries")
    .option("--auto-accept", "Also set hooks_auto_accept: true so the hooks need no TTY consent")
    .action((opts: { scope?: string; force?: boolean; autoAccept?: boolean }) => {
      rejectProjectScope(opts.scope);
      const result = performInstall({
        force: opts.force ?? false,
        autoAccept: opts.autoAccept ?? false,
      });
      console.error(
        result.changed
          ? `[prim] Hermes integration installed at ${result.path}`
          : `[prim] Hermes integration already present at ${result.path} (no changes)`,
      );
      console.error(TRUST_NOTICE);
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });

  hermes
    .command("uninstall")
    .description("Remove all prim hooks from Hermes's ~/.hermes/config.yaml")
    .action(() => {
      const result = performUninstall();
      console.error(
        result.changed
          ? `[prim] prim hooks removed from ${result.path}`
          : `[prim] no prim hooks to remove at ${result.path} (nothing changed)`,
      );
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });

  hermes
    .command("status")
    .description("Report whether each prim surface (gate, capture) is installed")
    .action(() => {
      const result = performStatus();
      const mark = (b: boolean): string => (b ? "✓" : "✗");
      console.error(
        `[prim] hermes: gate ${mark(result.gate)} · capture ${mark(result.capture)} (${result.path})`,
      );
      console.log(JSON.stringify(result, null, JSON_INDENT));
    });
}
