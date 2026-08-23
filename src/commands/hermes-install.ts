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
 *   - prim-pre-tool-use (gate) and prim-post-tool-use (outcome ingest) on
 *     Hermes's edit tools, plus correlated approval denials.
 *   - prim-session-start / prim-session-end on the session boundaries, so the
 *     daemon's presence reflects live Hermes sessions.
 *
 * The target is YAML, not JSON, and a file the user hand-maintains. We
 *      rewrite ONLY the text of its top-level `hooks:` block (a byte-level
 *      splice, not a document re-serialize), so the user's providers, models,
 *      comments, and formatting everywhere else survive byte-for-byte.
 *
 * Writes atomically (tmp + fsync + rename). AX contract (matches `prim claude`
 * / `prim codex`): STDOUT is the JSON result; STDERR is the human verdict.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { Document, isMap, isSeq, parseDocument, stringify } from "yaml";
import { atomicWriteFile } from "../lib/atomic-file.js";
import { stableHookCommand } from "../lib/bin-path.js";
import { stageHookRuntime } from "../lib/hook-runtime.js";

const CAPTURE_BIN = "prim-hook";
const GATE_BIN = "prim-pre-tool-use";
const POST_TOOL_USE_BIN = "prim-post-tool-use";
const SESSION_START_BIN = "prim-session-start";
const SESSION_END_BIN = "prim-session-end";
const HERMES_ARGS = "--agent hermes";
const EDIT_MATCHER = "write_file|patch";
const JSON_INDENT = 2;
const PRIM_BINS = [CAPTURE_BIN, GATE_BIN, POST_TOOL_USE_BIN, SESSION_START_BIN, SESSION_END_BIN];

// HERMES_HOME defaults to ~/.hermes; honor it so a relocated Hermes is found.
function hermesHome(): string {
  return process.env.HERMES_HOME ?? join(homedir(), ".hermes");
}
function configPath(): string {
  return join(hermesHome(), "config.yaml");
}
function legacyShimPath(): string {
  return join(hermesHome(), "agent-hooks", "prim-shim.sh");
}

// `stableHookCommand` explicitly enters /bin/sh, so Hermes's shell=False
// execution retains the same config-root resolution as Claude and Codex.
function commandFor(bin: string): string {
  return stableHookCommand(bin, HERMES_ARGS);
}

// A hook command is prim's when it routes `bin` through the prim shim. The
// shim name + bin token is stable regardless of the (machine-specific) home
// prefix; the optional `"` tolerates the quoted-path form, and the five bin
// names are mutually non-substring.
function commandUsesBin(command: string, bin: string): boolean {
  return new RegExp(`(?:prim-hook-launcher-v1|prim-shim\\.sh)"?[^\n]*\\s${bin}\\s`).test(command);
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

// The conflict gate is synchronous — Hermes waits on its block/allow — so it
// carries an explicit timeout ceiling; the shim's npx cold-start fallback can
// otherwise precede the binary's own internal timeouts.
const GATE_TIMEOUT_SECONDS = 10;

type HermesReg = { event: string; matcher?: string; bin: string; timeout?: number };

// Capture on every observed event; the gate/ingest on the edit tools; the
// session hooks on the boundaries. pre_tool_call and post_tool_call each carry
// two prim entries (capture + their dedicated hook), as on Claude/Codex.
const REGISTRATIONS: HermesReg[] = [
  ...CAPTURE_EVENTS.map((event) => ({ event, bin: CAPTURE_BIN })),
  { event: "pre_tool_call", matcher: EDIT_MATCHER, bin: GATE_BIN, timeout: GATE_TIMEOUT_SECONDS },
  { event: "post_tool_call", matcher: EDIT_MATCHER, bin: POST_TOOL_USE_BIN },
  { event: "post_approval_response", bin: POST_TOOL_USE_BIN },
  { event: "on_session_start", bin: SESSION_START_BIN },
  { event: "on_session_end", bin: SESSION_END_BIN },
];

export type HookEntry = { matcher?: string; command: string; timeout?: number };
export type HooksMap = Record<string, HookEntry[]>;

function entryFor(reg: HermesReg): HookEntry {
  const command = commandFor(reg.bin);
  const entry: HookEntry = reg.matcher ? { matcher: reg.matcher, command } : { command };
  if (reg.timeout !== undefined) {
    entry.timeout = reg.timeout;
  }
  return entry;
}

// Strip every entry whose command routes through `bin`, leaving co-located
// non-prim hooks under the same event intact.
export function stripBin(list: HookEntry[], bin: string): HookEntry[] {
  return list.filter((e) => !commandUsesBin(e.command, bin));
}

export function ensureReg(list: HookEntry[], reg: HermesReg, force: boolean): HookEntry[] {
  const entry = entryFor(reg);
  const present = list.some(
    (e) =>
      e.command === entry.command &&
      (e.matcher ?? "") === (entry.matcher ?? "") &&
      (e.timeout ?? null) === (entry.timeout ?? null),
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

// Locate the top-level `hooks:` block in raw YAML text — from the `hooks:` line
// through its indented children, up to the next top-level KEY (a column-0,
// non-comment, non-blank line) or EOF. Returns char offsets, or null when
// absent. This is the seam that lets install/uninstall rewrite ONLY that region.
function locateHooksBlock(raw: string): { start: number; end: number } | null {
  const lines = raw.split("\n");
  let offset = 0;
  let start = -1;
  let end = raw.length;
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length + 1; // +1 for the "\n" split removed
    if (start === -1) {
      if (/^hooks:(\s|$)/.test(line)) {
        start = lineStart;
      }
    } else if (/^\S/.test(line) && !line.startsWith("#")) {
      // A column-0 COMMENT can legally sit inside the indented hooks mapping —
      // only a real top-level key ends the block. Ending it at a comment would
      // orphan the post-comment hook children and re-emit a duplicate event key
      // (invalid YAML), corrupting the user's config.
      end = lineStart;
      break;
    }
  }
  return start === -1 ? null : { start, end };
}

// The prim hooks as a top-level YAML block ("" when empty). lineWidth: 0 keeps
// the long shim commands on a single line.
function serializeHooks(hooks: HooksMap): string {
  if (Object.keys(hooks).length === 0) {
    return "";
  }
  return stringify({ hooks }, { lineWidth: 0 });
}

type YamlValue = {
  toJSON?: () => unknown;
  comment?: string | null;
  commentBefore?: string | null;
  spaceBefore?: boolean;
};

function yamlValue(node: unknown): unknown {
  return typeof (node as YamlValue | null)?.toJSON === "function"
    ? (node as YamlValue).toJSON?.()
    : node;
}

function hookEntry(node: unknown): HookEntry | null {
  const value = yamlValue(node);
  return typeof value === "object" &&
    value !== null &&
    typeof (value as HookEntry).command === "string"
    ? (value as HookEntry)
    : null;
}

function isPrimEntry(entry: HookEntry): boolean {
  return PRIM_BINS.some((bin) => commandUsesBin(entry.command, bin));
}

function entryKey(entry: HookEntry): string {
  return JSON.stringify(entry);
}

function copyComments(source: unknown, target: unknown): void {
  const from = source as YamlValue | null;
  const to = target as YamlValue | null;
  if (!from || !to) return;
  if (from.commentBefore !== undefined && to.commentBefore === undefined) {
    to.commentBefore = from.commentBefore;
  }
  if (from.comment !== undefined && to.comment === undefined) {
    to.comment = from.comment;
  }
  if (from.spaceBefore !== undefined && to.spaceBefore === undefined) {
    to.spaceBefore = from.spaceBefore;
  }
}

/**
 * Reconcile one sequence without rebuilding user-owned nodes. Valid entries
 * follow the merge helper's requested order; malformed/foreign nodes retain
 * their original AST nodes, comments, and relative positions.
 */
function reconcileSequence(
  doc: Document,
  sequence: { items: unknown[] },
  desired: HookEntry[],
): void {
  const available = new Map<string, unknown[]>();
  const displacedPrim: unknown[] = [];
  for (const node of sequence.items) {
    const entry = hookEntry(node);
    if (!entry) continue;
    const key = entryKey(entry);
    const nodes = available.get(key) ?? [];
    nodes.push(node);
    available.set(key, nodes);
  }

  const desiredNodes = desired.map((entry) => {
    const candidates = available.get(entryKey(entry));
    const reused = candidates?.shift();
    return reused ?? doc.createNode(entry);
  });

  for (const nodes of available.values()) {
    for (const node of nodes) {
      const entry = hookEntry(node);
      if (entry && isPrimEntry(entry)) displacedPrim.push(node);
    }
  }

  const newPrimNodes = desiredNodes.filter((node) => {
    const entry = hookEntry(node);
    return entry !== null && isPrimEntry(entry) && !sequence.items.includes(node);
  });
  for (let i = 0; i < Math.min(displacedPrim.length, newPrimNodes.length); i += 1) {
    copyComments(displacedPrim[i], newPrimNodes[i]);
  }

  const next: unknown[] = [];
  let desiredIndex = 0;
  for (const node of sequence.items) {
    if (hookEntry(node) === null) {
      next.push(node);
    } else if (desiredIndex < desiredNodes.length) {
      next.push(desiredNodes[desiredIndex]);
      desiredIndex += 1;
    }
  }
  next.push(...desiredNodes.slice(desiredIndex));
  sequence.items = next;
}

/** Rewrite only the hooks AST, retaining comments and unrecognized user data. */
function reconcileHooksDocument(doc: Document, desired: HooksMap): boolean {
  const hooksNode = doc.get("hooks", true);
  if (hooksNode === undefined) {
    if (Object.keys(desired).length === 0) return false;
    doc.set("hooks", desired);
    return true;
  }
  if (!isMap(hooksNode)) {
    if (Object.keys(desired).length === 0) return false;
    throw new Error("cannot merge Primitive hooks into a non-mapping hooks value");
  }

  const seen = new Set<string>();
  for (const pair of [...hooksNode.items]) {
    const event = yamlValue(pair.key);
    if (typeof event !== "string") continue;
    if (seen.has(event)) {
      throw new Error(`cannot safely merge duplicate Hermes hook event ${JSON.stringify(event)}`);
    }
    seen.add(event);

    const expected = desired[event] ?? [];
    if (!isSeq(pair.value)) {
      if (expected.length > 0) {
        throw new Error(
          `cannot merge Primitive hooks into non-list event ${JSON.stringify(event)}`,
        );
      }
      continue;
    }
    reconcileSequence(doc, pair.value, expected);
    if (pair.value.items.length === 0) {
      hooksNode.delete(event);
    }
  }

  for (const [event, entries] of Object.entries(desired)) {
    if (!seen.has(event)) {
      hooksNode.set(event, doc.createNode(entries));
    }
  }

  if (hooksNode.items.length === 0) {
    doc.delete("hooks");
    return false;
  }
  return true;
}

// Replace ONLY the `hooks:` block with `hooks`'s serialization (or remove it
// when empty), preserving every other byte of the file. Appends the block when
// the file has none.
export function spliceHooks(raw: string, hooks: HooksMap): string {
  const loc = locateHooksBlock(raw);
  if (!loc) {
    const block = serializeHooks(hooks);
    if (block.length === 0) return raw;
    const sep = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
    return `${raw}${sep}${block}`;
  }

  const doc = parseDocument(raw);
  const hasHooks = reconcileHooksDocument(doc, hooks);
  if (!hasHooks) {
    return raw.slice(0, loc.start) + raw.slice(loc.end);
  }
  const serialized = doc.toString({ lineWidth: 0 });
  const serializedLoc = locateHooksBlock(serialized);
  if (!serializedLoc) {
    throw new Error("Hermes hooks merge lost the hooks mapping");
  }
  const block = serialized.slice(serializedLoc.start, serializedLoc.end);
  return raw.slice(0, loc.start) + block + raw.slice(loc.end);
}

function hasAutoAccept(raw: string): boolean {
  return /^hooks_auto_accept:/m.test(raw);
}

// Ensure `hooks_auto_accept: true` is present — replacing an existing value or
// appending the key, touching only that one line.
function setAutoAccept(raw: string): string {
  if (hasAutoAccept(raw)) {
    return raw.replace(/^hooks_auto_accept:.*$/m, "hooks_auto_accept: true");
  }
  const sep = raw.length === 0 || raw.endsWith("\n") ? "" : "\n";
  return `${raw}${sep}hooks_auto_accept: true\n`;
}

// True when the merged content is at least as parseable as the original — i.e.
// the splice introduced no NEW structural error. Comparing error COUNTS (not
// just "is it clean now") means a pre-existing ambiguity the user's YAML loader
// already tolerates (e.g. a duplicate top-level key, which PyYAML reads
// last-wins) is never mistaken for our corruption and never blocks the install.
export function mergeKeepsYamlValid(before: string, after: string): boolean {
  return parseDocument(after).errors.length <= parseDocument(before).errors.length;
}

/** A syntactically valid write must also contain exactly the requested valid hooks. */
export function mergePreservesHermesSemantics(
  before: string,
  after: string,
  expectedHooks: HooksMap,
): boolean {
  if (!mergeKeepsYamlValid(before, after)) return false;
  try {
    return JSON.stringify(readHooksFromRaw(after)) === JSON.stringify(expectedHooks);
  } catch {
    return false;
  }
}

const INVALID_MERGE_MESSAGE =
  "[prim] aborted: the merge would change unrelated Hermes config; config left unchanged";

// Defense in depth: abort (leaving the file byte-untouched) if the splice
// introduced a new YAML error, rather than persist a config we made worse.
function assertMergeValid(before: string, after: string, expectedHooks: HooksMap): void {
  if (!mergePreservesHermesSemantics(before, after, expectedHooks)) {
    console.error(INVALID_MERGE_MESSAGE);
    process.exit(1);
  }
}

function writeConfig(path: string, before: string, after: string, expectedHooks: HooksMap): void {
  atomicWriteFile(path, after, {
    ensureParent: true,
    validate(temporaryPath) {
      const flushed = readFileSync(temporaryPath, "utf8");
      if (!mergePreservesHermesSemantics(before, flushed, expectedHooks)) {
        throw new Error(INVALID_MERGE_MESSAGE);
      }
    },
  });
}

function removeLegacyShim(): void {
  rmSync(legacyShimPath(), { force: true });
}

function autoAcceptOf(raw: string): boolean {
  if (raw.trim().length === 0) {
    return false;
  }
  return (parseDocument(raw).toJS() as Record<string, unknown> | null)?.hooks_auto_accept === true;
}

// Read the existing hooks from raw config text (empty when the file is blank).
function readHooksFromRaw(raw: string): HooksMap {
  return readHooks(raw.trim().length > 0 ? parseDocument(raw) : new Document());
}

export type InstallResult = {
  path: string;
  gate: boolean;
  capture: boolean;
  autoAccept: boolean;
  changed: boolean;
};

export function performInstall(opts: {
  force: boolean;
  autoAccept: boolean;
  stageRuntime?: () => unknown;
}): InstallResult {
  (opts.stageRuntime ?? stageHookRuntime)();
  const path = configPath();
  const raw = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const existing = readHooksFromRaw(raw);
  const desired = applyInstall(existing, opts.force);
  let next = raw;
  if (JSON.stringify(existing) !== JSON.stringify(desired)) {
    next = spliceHooks(next, desired);
  }
  if (opts.autoAccept) {
    next = setAutoAccept(next);
  }
  const changed = next !== raw;
  if (changed) assertMergeValid(raw, next, desired);
  if (changed) {
    writeConfig(path, raw, next, desired);
  }
  // Remove the superseded machine-specific shim only after the config no
  // longer references it. A crash before this point leaves harmless old bytes.
  removeLegacyShim();
  return {
    path,
    gate: isGateInstalled(desired),
    capture: isCaptureInstalled(desired),
    autoAccept: autoAcceptOf(next),
    changed,
  };
}

export function performUninstall(): InstallResult {
  const path = configPath();
  if (!existsSync(path)) {
    removeLegacyShim();
    return { path, gate: false, capture: false, autoAccept: false, changed: false };
  }
  const raw = readFileSync(path, "utf-8");
  const existing = readHooksFromRaw(raw);
  const remaining = applyUninstall(existing);
  const next =
    JSON.stringify(existing) === JSON.stringify(remaining) ? raw : spliceHooks(raw, remaining);
  const changed = next !== raw;
  if (changed) {
    assertMergeValid(raw, next, remaining);
    writeConfig(path, raw, next, remaining);
  }
  // Every prim hook is gone now, so the shim it routed through is unused. The
  // user's hooks_auto_accept (if any) is left as their trust setting.
  removeLegacyShim();
  return {
    path,
    gate: isGateInstalled(remaining),
    capture: isCaptureInstalled(remaining),
    autoAccept: autoAcceptOf(next),
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
