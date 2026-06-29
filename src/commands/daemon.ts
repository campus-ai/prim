/**
 * `prim daemon start | stop | status | restart` — the long-lived prim
 * companion process.
 *
 * Lifecycle:
 *   prim daemon start                spawn detached, return immediately
 *   prim daemon start --foreground   run inline (useful under launchd)
 *   prim daemon stop                 SIGTERM, wait up to 5s, cleanup
 *   prim daemon status               liveness probe + status snapshot
 *   prim daemon restart              stop + start
 *
 * The daemon binary is `prim-daemon-server`, installed alongside the
 * other bins by `npm i -g @primitive.ai/prim`. In a dev checkout you
 * must `pnpm build` then ensure the bin resolves on PATH (typically
 * via `pnpm link --global` or a `dist/daemon/server.js` shim).
 *
 * AX contract: STDERR verdict-first; STDOUT machine-readable JSON.
 */

import { type SpawnOptions, spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { daemonIsLive, daemonRequest } from "../daemon/client.js";
import { binFile } from "../lib/bin-path.js";
import { formatTeammates } from "../lib/presence.js";

const DAEMON_BIN = "prim-daemon-server";
const CONFIG_DIR = join(homedir(), ".config", "prim");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");
const SOCK_PATH = join(CONFIG_DIR, "sock");
const LOG_PATH = join(CONFIG_DIR, "daemon.log");

const CONFIG_DIR_MODE = 0o700;
const LOG_FILE_MODE = 0o600;

const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 100;
const STATUS_PROBE_TIMEOUT_MS = 500;
// `start` polls the socket — the real readiness signal — until the daemon
// answers a ping, instead of peeking the pidfile once. The server writes its
// pidfile BEFORE it binds the socket (server.ts), and a cold Node start can
// outlast a single short wait, so the old 400ms pidfile peek raced boot and
// reported a healthy, still-starting daemon as "down". Poll up to the deadline.
const READY_TIMEOUT_MS = 5_000;
const READY_POLL_MS = 100;
const READY_PROBE_TIMEOUT_MS = 250;
const EXIT_OK = 0;
const EXIT_NOT_RUNNING = 2;
// Pidfile alive but the socket isn't answering yet — booting (or wedged),
// distinct from hard-down so an agent can retry rather than treat it as failed.
const EXIT_BOOTING = 3;

interface RunningPid {
  pid: number;
  alive: boolean;
}

interface StatusSnapshot {
  pid: number;
  uptimeMs: number;
  sessionId: string;
  lastHeartbeatAt?: number;
  onlineCount?: number;
  // Online teammates (self excluded), sorted. Surfaced in full here, where
  // there's room; the statusline truncates the same list.
  onlineNames?: string[];
}

function readPidfile(): RunningPid | null {
  if (!existsSync(PID_PATH)) {
    return null;
  }
  const raw = readFileSync(PID_PATH, "utf-8").trim();
  const pid = Number(raw);
  if (!Number.isInteger(pid) || pid <= 0) {
    return null;
  }
  return { pid, alive: processIsAlive(pid) };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function clearStaleArtifacts(): void {
  try {
    unlinkSync(PID_PATH);
  } catch {
    // pidfile already gone
  }
  try {
    unlinkSync(SOCK_PATH);
  } catch {
    // socket already gone
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref();
  });
}

/**
 * Spawn the daemon server by absolute path (`<node> <abs>/server.js`) so it
 * resolves regardless of PATH; fall back to the bare bin name for dev checkouts
 * that link it onto PATH (`pnpm link --global`).
 */
function spawnDaemon(options: SpawnOptions) {
  const file = binFile(DAEMON_BIN);
  return file ? spawn(process.execPath, [file], options) : spawn(DAEMON_BIN, [], options);
}

/**
 * Open the daemon log for appending (creating the config dir if needed) so
 * the detached daemon can inherit it as stdout+stderr. The daemon already
 * writes its lifecycle and crash lines to those streams; without a real file
 * the detached spawn sent them to /dev/null, leaving a crash with no trace on
 * disk. Returns the fd; the caller closes its own copy after handing it to
 * the child.
 */
export function openDaemonLog(configDir: string = CONFIG_DIR): number {
  if (!existsSync(configDir)) {
    mkdirSync(configDir, { recursive: true, mode: CONFIG_DIR_MODE });
  }
  return openSync(join(configDir, "daemon.log"), "a", LOG_FILE_MODE);
}

/** Poll the socket until the daemon answers a ping or the deadline elapses. */
async function waitForReady(): Promise<boolean> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await daemonIsLive(READY_PROBE_TIMEOUT_MS)) {
      return true;
    }
    await sleep(READY_POLL_MS);
  }
  return daemonIsLive(READY_PROBE_TIMEOUT_MS);
}

async function daemonStart(opts: { foreground?: boolean }): Promise<void> {
  const existing = readPidfile();
  if (existing?.alive) {
    process.stderr.write(`[prim] daemon already running (pid=${existing.pid})\n`);
    console.log(JSON.stringify({ started: false, pid: existing.pid }, null, 2));
    return;
  }
  if (existing && !existing.alive) {
    clearStaleArtifacts();
  }

  if (opts.foreground) {
    // Inherit all stdio so the user sees the daemon's lifecycle log.
    const child = spawnDaemon({ stdio: "inherit" });
    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  // Hand the detached child an append fd to ~/.config/prim/daemon.log for
  // stdout+stderr so its heartbeat/crash lines survive instead of going to
  // /dev/null. Fail-soft: if the log can't be opened, discard rather than
  // block startup.
  let logFd: number | undefined;
  try {
    logFd = openDaemonLog();
  } catch {
    logFd = undefined;
  }
  const child = spawnDaemon({
    detached: true,
    stdio: logFd === undefined ? ["ignore", "ignore", "ignore"] : ["ignore", logFd, logFd],
  });
  child.unref();
  if (logFd !== undefined) {
    closeSync(logFd);
  }

  // Block until the daemon actually answers on its socket — the only signal
  // that it's ready to serve — so a chained `status` can't race the boot.
  const live = await waitForReady();
  if (live) {
    const after = readPidfile();
    process.stderr.write(
      `[prim] ✓ daemon started (pid=${after?.pid ?? "?"}, socket=${SOCK_PATH})\n`,
    );
    console.log(JSON.stringify({ started: true, pid: after?.pid }, null, 2));
    return;
  }
  process.stderr.write(
    `[prim] ✗ daemon start: spawned but the socket did not respond within ${READY_TIMEOUT_MS}ms (check that \`${DAEMON_BIN}\` resolves, and see ${LOG_PATH})\n`,
  );
  console.log(JSON.stringify({ started: false }, null, 2));
  if (!process.exitCode) {
    process.exitCode = EXIT_NOT_RUNNING;
  }
}

async function daemonStop(): Promise<void> {
  const existing = readPidfile();
  if (!existing) {
    process.stderr.write("[prim] daemon not running (no pidfile)\n");
    console.log(JSON.stringify({ stopped: false, wasRunning: false }, null, 2));
    return;
  }
  if (!existing.alive) {
    clearStaleArtifacts();
    process.stderr.write("[prim] daemon not running (cleared stale pidfile)\n");
    console.log(JSON.stringify({ stopped: false, wasRunning: false }, null, 2));
    return;
  }
  try {
    process.kill(existing.pid, "SIGTERM");
  } catch (err) {
    process.stderr.write(
      `[prim] could not signal pid=${existing.pid}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    console.log(JSON.stringify({ stopped: false, pid: existing.pid }, null, 2));
    return;
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (!processIsAlive(existing.pid)) {
      clearStaleArtifacts();
      process.stderr.write(`[prim] daemon stopped (pid=${existing.pid})\n`);
      console.log(JSON.stringify({ stopped: true, pid: existing.pid }, null, 2));
      return;
    }
    await sleep(STOP_POLL_MS);
  }
  process.stderr.write(
    `[prim] daemon did not exit within ${STOP_TIMEOUT_MS}ms (pid=${existing.pid} still alive)\n`,
  );
  console.log(JSON.stringify({ stopped: false, pid: existing.pid }, null, 2));
}

export type DaemonStatusVerdict = {
  json: Record<string, unknown>;
  exitCode: number;
};

/**
 * Map daemon liveness onto the reported JSON + process exit code. Pure, so the
 * exit-code contract is unit-tested independently of sockets:
 *   - hard down (no live pid)         -> EXIT_NOT_RUNNING (2)
 *   - pid alive, socket not answering -> EXIT_BOOTING (3), state "starting"
 *   - live                            -> EXIT_OK (0)
 * Splitting "booting" from "down" stops a daemon that's still coming up from
 * reading as a hard failure — the exact misread that made a healthy restart
 * look broken when a status check was chained immediately after it.
 */
export function classifyStatus(
  pidAlive: boolean,
  responding: boolean,
  snapshot: StatusSnapshot | null,
  pid?: number,
): DaemonStatusVerdict {
  if (!pidAlive) {
    return { json: { running: false }, exitCode: EXIT_NOT_RUNNING };
  }
  if (!responding) {
    return {
      json: { running: true, responding: false, state: "starting", pid },
      exitCode: EXIT_BOOTING,
    };
  }
  if (!snapshot) {
    return { json: { running: true, responding: true }, exitCode: EXIT_OK };
  }
  return { json: { running: true, responding: true, ...snapshot }, exitCode: EXIT_OK };
}

async function daemonStatus(): Promise<void> {
  const pid = readPidfile();
  const pidAlive = pid?.alive ?? false;
  const responding = pidAlive ? await daemonIsLive(STATUS_PROBE_TIMEOUT_MS) : false;
  const snapshot = responding
    ? await daemonRequest<StatusSnapshot>(
        "status_snapshot",
        {},
        { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
      )
    : null;

  const { json, exitCode } = classifyStatus(pidAlive, responding, snapshot, pid?.pid);

  if (!pidAlive) {
    process.stderr.write("[prim] ✗ daemon down\n");
  } else if (!responding) {
    process.stderr.write(`[prim] ◌ daemon pid=${pid?.pid} starting (socket not responding yet)\n`);
  } else if (!snapshot) {
    process.stderr.write("[prim] ✓ daemon live (no snapshot)\n");
  } else {
    // Full teammate list (self excluded) when presence is fresh; omit the
    // segment entirely when names are unknown rather than print "team: —".
    const team =
      snapshot.onlineNames !== undefined
        ? ` · team: ${formatTeammates(snapshot.onlineNames, Number.POSITIVE_INFINITY)}`
        : "";
    process.stderr.write(
      `[prim] ✓ daemon live · pid=${snapshot.pid} · uptime=${Math.round(snapshot.uptimeMs / 1000)}s · session=${snapshot.sessionId}${team}\n`,
    );
  }
  console.log(JSON.stringify(json, null, 2));
  if (exitCode !== EXIT_OK && !process.exitCode) {
    process.exitCode = exitCode;
  }
}

async function daemonRestart(opts: { foreground?: boolean }): Promise<void> {
  await daemonStop();
  await daemonStart(opts);
}

export function registerDaemonCommands(program: Command): void {
  const daemon = program
    .command("daemon")
    .description("Manage the prim companion daemon (latency unlock + presence + broadcast)");

  daemon
    .command("start")
    .description("Spawn the prim-daemon-server in the background")
    .option("--foreground", "Run in the foreground (inherit stdio); use under launchd / systemd")
    .action(async (opts: { foreground?: boolean }) => {
      await daemonStart(opts);
    });

  daemon
    .command("stop")
    .description("Send SIGTERM to the running daemon and clean up the socket")
    .action(async () => {
      await daemonStop();
    });

  daemon
    .command("status")
    .description("Report daemon liveness + a snapshot if responding")
    .action(async () => {
      await daemonStatus();
    });

  daemon
    .command("restart")
    .description("Stop, then start (preserves no state today)")
    .option("--foreground", "Restart in the foreground")
    .action(async (opts: { foreground?: boolean }) => {
      await daemonRestart(opts);
    });
}
