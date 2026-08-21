/**
 * `prim statusline` — print Claude Code statusLine output.
 *
 * Spawned by Claude Code on every configured status refresh. Reads
 * the daemon's status snapshot and renders a single-line summary:
 *
 *   primitive 0.4.2 (daemon: live, Decision ingestion enabled · team: 4 online)
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
import { decisionIngestionStatus, repositoryBindingState } from "../lib/activation.js";
import { warmBinCache } from "../lib/bin-cache.js";
import { type StatusSnapshot, formatStatusline } from "../lib/statusline-render.js";

const STATUSLINE_TIMEOUT_MS = 200;

export function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const candidates = [
      // Schema-v2 runtimes staged a manifest beside this standalone bundle.
      // Keep resolving it while those legacy launchers transition to schema v3.
      resolve(here, "manifest.json"),
      resolve(here, "../../package.json"),
      resolve(here, "../package.json"),
    ];
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
  const cwd = process.cwd();
  let ingestion: ReturnType<typeof decisionIngestionStatus> | undefined;
  const resolveIngestion = () => {
    ingestion ??= decisionIngestionStatus(cwd);
    return ingestion;
  };
  const snapshot = await daemonRequest<StatusSnapshot>(
    "status_snapshot",
    // callerEnv lets the daemon withhold presence when it is bound to a different
    // deployment than this statusline targets.
    { callerEnv: getSiteUrl() },
    { timeoutMs: STATUSLINE_TIMEOUT_MS },
  );
  if (!snapshot) {
    debug("daemon snapshot missing");
  }
  return formatStatusline(version, snapshot, resolveIngestion, {
    resolveRepositoryBindingState: () =>
      resolveIngestion() === "enabled" ? repositoryBindingState(cwd) : undefined,
  });
}

export function registerStatuslineCommands(program: Command): void {
  program
    .command("statusline")
    .description("Render the Claude Code statusLine for the prim companion daemon")
    .action(async () => {
      try {
        // Status refresh is the highest-frequency shim caller; keep the bin cache
        // warm so it execs directly instead of re-resolving npx each tick.
        warmBinCache();
        const line = await renderStatusline();
        process.stdout.write(line);
      } catch {
        // A configured statusline that emits nothing disappears completely in
        // Claude Code. Fail soft, but stay visible and honest.
        process.stdout.write(`primitive ${readPackageVersion()} (daemon: unavailable)`);
      }
    });
}
