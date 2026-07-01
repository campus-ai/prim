#!/usr/bin/env node
/**
 * prim-hook — passive coding-agent event collector (Claude Code and Codex).
 *
 * Reads a single hook event from stdin, scrubs PII/secrets, wraps it in a
 * Move envelope, resolves its owning org, appends to that org's local
 * NDJSON journal, exits 0. Never blocks the Claude Code session: any error
 * is swallowed (set PRIM_HOOK_DEBUG to surface it on stderr) and the
 * process always exits 0.
 *
 * On a session-terminal event it spawns a detached `prim moves flush` so
 * the session's captured moves drain promptly — without dragging the
 * auth/HTTP subsystem into this per-tool-call cold path. The binding
 * resolver and the redaction filter are pure file IO, so they stay
 * cold-path-safe.
 *
 * Installed via: prim claude install
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveOrg } from "../binding.js";
import { appendMove } from "../journal.js";
import { isRepoActive } from "../lib/activation.js";
import { parseAgent } from "./agent.js";
import { normalizeEnvelope } from "./normalize.js";
import { shouldFlushAfter, toMove } from "./prim-hook-core.js";
import { scrubFromCwd } from "./redact.js";

const here = dirname(fileURLToPath(import.meta.url));

function resolveCliVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "..", "..", "package.json"), "utf-8")) as {
      version?: string;
    };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function spawnBackgroundFlush(): void {
  const entry = join(here, "..", "index.js");
  spawn(process.execPath, [entry, "moves", "flush"], {
    detached: true,
    stdio: "ignore",
  }).unref();
}

try {
  const agent = parseAgent(process.argv);
  const raw = readFileSync(0, "utf-8");
  // Normalize Hermes event names into prim's internal vocabulary at the wire
  // boundary (a no-op for Claude Code / Codex), so eventType and the
  // shouldFlushAfter drain trigger key on the names every downstream guard
  // already expects.
  const parsed = normalizeEnvelope(JSON.parse(raw) as Record<string, unknown>, agent);
  const cwd = (parsed.cwd as string | undefined) ?? process.cwd();
  // Opt-in gate: capture only in repos where prim is activated (prim.active).
  // Inactive repos short-circuit here — nothing is built, journaled, or flushed
  // — so a machine-wide (user-scope) install never captures where unwanted.
  if (isRepoActive(cwd)) {
    // Derive the envelope's identity/control fields (sessionId, eventType,
    // env.cwd) from the (normalized) event so org binding is provably
    // independent of redaction, then scrub ONLY the payload body that persists
    // to the journal, transits to the server, and lands in the moves table.
    const base = toMove(parsed, resolveCliVersion(), agent);
    const move = { ...base, payload: scrubFromCwd(parsed, cwd) };
    const { orgId } = resolveOrg({ sessionId: move.sessionId, cwd: move.env.cwd });
    appendMove(move, orgId);
    if (shouldFlushAfter(move.eventType)) {
      spawnBackgroundFlush();
    }
  }
} catch (err) {
  if (process.env.PRIM_HOOK_DEBUG) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[prim-hook] capture failed: ${detail}\n`);
  }
}
process.exit(0);
