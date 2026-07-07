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
import { getSiteUrl } from "../client.js";
import { daemonRequest } from "../daemon/client.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { formatTeammates, formatTeammatesWithArea } from "../lib/presence.js";

type StatusSnapshot = {
  pid: number;
  uptimeMs: number;
  sessionId: string;
  lastHeartbeatAt?: number;
  // From the daemon's last accepted heartbeat ack (server-derived from the
  // token). `onlineTeammates` are the online teammates (self excluded), sorted,
  // each with the area of their most recent decision — preferred when present.
  // `onlineNames` is the same roster without areas, kept for a server that
  // predates `onlineTeammates`. `onlineCount` is the self-inclusive count, a
  // last-resort fallback for a server that predates names entirely.
  onlineCount?: number;
  onlineNames?: string[];
  onlineTeammates?: { name: string; area?: string }[];
  // True when the daemon is alive but its heartbeats have stopped landing, so
  // the cached presence is frozen and not to be trusted.
  presenceStale?: boolean;
  // True when the daemon is bound to a DIFFERENT deployment than this statusline
  // targets; presence is withheld (it would be another env's roster).
  envMismatch?: boolean;
};

const STATUSLINE_TIMEOUT_MS = 200;
// Names shown before collapsing the rest into "+N" — keeps the one-line
// statusline from overflowing on a busy team.
const STATUSLINE_NAME_CAP = 3;

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
    // callerEnv lets the daemon withhold presence when it is bound to a different
    // deployment than this statusline targets.
    { callerEnv: getSiteUrl() },
    { timeoutMs: STATUSLINE_TIMEOUT_MS },
  );
  if (!snapshot) {
    debug("daemon snapshot missing");
    return `primitive ${version} (daemon: down)`;
  }
  // The daemon is alive but on another deployment — show that honestly rather
  // than its env's team or a misleading "down".
  if (snapshot.envMismatch) {
    return `primitive ${version} (daemon: live · presence: other env)`;
  }
  // A stale snapshot means the daemon is alive but its heartbeats are failing —
  // the cached presence is frozen, so render the degraded state honestly
  // instead of a confident, wrong roster.
  if (snapshot.presenceStale) {
    return `primitive ${version} (daemon: live · presence: stale)`;
  }
  // Prefer teammates-with-area ("Kasey - auth, Sam +3"); fall back to bare
  // names for a server that predates areas ("Maya, Alex +3" / "just you"); then
  // to the bare count for one that predates names — each better than regressing
  // to "—"; and to "—" when none is fresh (no ack yet, or the last ack was
  // org-unbound), which is unknown, not necessarily a team of one.
  let team: string;
  if (snapshot.onlineTeammates !== undefined) {
    team = `team: ${formatTeammatesWithArea(snapshot.onlineTeammates, STATUSLINE_NAME_CAP)}`;
  } else if (snapshot.onlineNames !== undefined) {
    team = `team: ${formatTeammates(snapshot.onlineNames, STATUSLINE_NAME_CAP)}`;
  } else if (typeof snapshot.onlineCount === "number") {
    team = `team: ${String(snapshot.onlineCount)} online`;
  } else {
    team = "team: —";
  }
  return `primitive ${version} (daemon: live · ${team})`;
}

export function registerStatuslineCommands(program: Command): void {
  program
    .command("statusline")
    .description("Render the Claude Code statusLine for the prim companion daemon")
    .action(async () => {
      try {
        // ~1Hz refresh is the highest-frequency shim caller; keep the bin cache
        // warm so it execs directly instead of re-resolving npx each tick.
        warmBinCache();
        const line = await renderStatusline();
        process.stdout.write(line);
      } catch {
        // fail soft — emit nothing so Claude Code's statusline stays blank
      }
    });
}
