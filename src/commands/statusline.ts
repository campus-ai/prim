/**
 * `prim statusline` — print Claude Code statusLine output.
 *
 * Spawned by Claude Code on every status refresh (~1Hz idle). Reads
 * the daemon's status snapshot and renders a single-line summary:
 *
 *   primitive 0.4.2 (daemon: live · team: 4 online)
 *
 * When the daemon's down, falls back to a quieter form:
 *
 *   primitive 0.4.2 (daemon: down)
 *
 * Fail-soft on every error path. Exit 0 always.
 *
 * AX contract: STDOUT is the single statusline string (no trailing
 * newline — Claude Code adds one). STDERR is silent unless
 * `PRIM_STATUSLINE_DEBUG=1`.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { Command } from "commander";
import { daemonRequest } from "../daemon/client.js";

type StatusSnapshot = {
  pid: number;
  uptimeMs: number;
  sessionId: string;
  lastHeartbeatAt?: number;
  // Self-inclusive same-org online count from the daemon's last accepted
  // heartbeat ack. The server owns display names (derived from the token), so
  // the daemon asserts none — the statusline shows only the count.
  onlineCount?: number;
  // True when the daemon is alive but its heartbeats have stopped landing, so
  // the cached count is frozen and not to be trusted.
  presenceStale?: boolean;
};

const STATUSLINE_TIMEOUT_MS = 200;

function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [resolve(here, "../../package.json"), resolve(here, "../package.json")];
    for (const path of candidates) {
      try {
        const pkg = JSON.parse(readFileSync(path, "utf-8")) as {
          version?: string;
        };
        if (pkg.version) {
          return pkg.version;
        }
      } catch {
        // try next candidate
      }
    }
  } catch {
    // best-effort version resolution; fall through
  }
  return "0.0.0";
}

function debug(msg: string): void {
  if (process.env.PRIM_STATUSLINE_DEBUG === "1") {
    process.stderr.write(`[prim-statusline] ${msg}\n`);
  }
}

export async function renderStatusline(): Promise<string> {
  const version = readPackageVersion();
  const snapshot = await daemonRequest<StatusSnapshot>(
    "status_snapshot",
    {},
    { timeoutMs: STATUSLINE_TIMEOUT_MS },
  );
  if (!snapshot) {
    debug("daemon snapshot missing");
    return `primitive ${version} (daemon: down)`;
  }
  // A stale snapshot means the daemon is alive but its heartbeats are failing —
  // the cached count is frozen, so render the degraded state honestly instead
  // of a confident, wrong "team: N".
  if (snapshot.presenceStale) {
    return `primitive ${version} (daemon: live · presence: stale)`;
  }
  // Render the real count when the daemon has a fresh accepted ack; otherwise
  // show an honest "—" rather than claiming a team of 1 — the count is unknown
  // (no ack yet, or the last ack was org-unbound), not necessarily one.
  const team =
    typeof snapshot.onlineCount === "number"
      ? `team: ${String(snapshot.onlineCount)} online`
      : "team: —";
  return `primitive ${version} (daemon: live · ${team})`;
}

export function registerStatuslineCommands(program: Command): void {
  program
    .command("statusline")
    .description("Render the Claude Code statusLine for the prim companion daemon")
    .action(async () => {
      try {
        const line = await renderStatusline();
        process.stdout.write(line);
      } catch {
        // fail soft — emit nothing so Claude Code's statusline stays blank
      }
    });
}
