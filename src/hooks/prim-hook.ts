#!/usr/bin/env node
/**
 * Decision Event Pipeline — Claude Code hook collector.
 *
 * Reads a single hook event from stdin, wraps it in a Move envelope,
 * appends to the local NDJSON journal, exits 0. Never blocks the Claude
 * Code session: any error is swallowed (set PRIM_HOOK_DEBUG to surface it
 * on stderr) and the process always exits 0.
 *
 * On a session-terminal event it spawns a detached `prim moves flush` so
 * the session's captured moves drain promptly — without dragging the
 * auth/HTTP subsystem into this per-tool-call cold path.
 *
 * Installed via: prim claude-install --apply
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { appendMove } from "../journal.js";
import { shouldFlushAfter, toMove } from "./prim-hook-core.js";

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
  const raw = readFileSync(0, "utf-8");
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  const move = toMove(parsed, resolveCliVersion());
  appendMove(move);
  if (shouldFlushAfter(move.eventType)) {
    spawnBackgroundFlush();
  }
} catch (err) {
  if (process.env.PRIM_HOOK_DEBUG) {
    const detail = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[prim-hook] capture failed: ${detail}\n`);
  }
}
process.exit(0);
