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

import { spawn } from "node:child_process";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command } from "commander";
import { daemonIsLive, daemonRequest } from "../daemon/client.js";

const DAEMON_BIN = "prim-daemon-server";
const PID_PATH = join(homedir(), ".config", "prim", "daemon.pid");
const SOCK_PATH = join(homedir(), ".config", "prim", "sock");

const STOP_TIMEOUT_MS = 5_000;
const STOP_POLL_MS = 100;
const STATUS_PROBE_TIMEOUT_MS = 500;
const POST_START_WAIT_MS = 400;
const EXIT_NOT_RUNNING = 2;

interface RunningPid {
  pid: number;
  alive: boolean;
}

interface StatusSnapshot {
  pid: number;
  uptimeMs: number;
  sessionId: string;
  displayName: string;
  lastHeartbeatAt?: number;
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
    // exec into the bin so the daemon takes over this process.
    const child = spawn(DAEMON_BIN, [], { stdio: "inherit" });
    child.on("exit", (code) => {
      process.exit(code ?? 0);
    });
    return;
  }

  const child = spawn(DAEMON_BIN, [], {
    detached: true,
    stdio: ["ignore", "ignore", "ignore"],
  });
  child.unref();

  // Give the daemon a beat to take the pidfile + open the socket.
  await sleep(POST_START_WAIT_MS);
  const after = readPidfile();
  if (after?.alive) {
    process.stderr.write(`[prim] daemon started (pid=${after.pid}, socket=${SOCK_PATH})\n`);
    console.log(JSON.stringify({ started: true, pid: after.pid }, null, 2));
    return;
  }
  process.stderr.write(
    "[prim] daemon start: bin spawned but no pidfile observed (check that `prim-daemon-server` is on PATH)\n",
  );
  console.log(JSON.stringify({ started: false }, null, 2));
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

async function daemonStatus(): Promise<void> {
  const pid = readPidfile();
  if (!pid?.alive) {
    process.stderr.write("[prim] ✗ daemon down\n");
    console.log(JSON.stringify({ running: false }, null, 2));
    if (!process.exitCode) {
      process.exitCode = EXIT_NOT_RUNNING;
    }
    return;
  }

  const live = await daemonIsLive(STATUS_PROBE_TIMEOUT_MS);
  if (!live) {
    process.stderr.write(`[prim] ✗ daemon pid=${pid.pid} alive but socket not responding\n`);
    console.log(JSON.stringify({ running: true, responding: false, pid: pid.pid }, null, 2));
    if (!process.exitCode) {
      process.exitCode = EXIT_NOT_RUNNING;
    }
    return;
  }

  const snapshot = await daemonRequest<StatusSnapshot>(
    "status_snapshot",
    {},
    { timeoutMs: STATUS_PROBE_TIMEOUT_MS },
  );
  if (!snapshot) {
    process.stderr.write("[prim] ✓ daemon live (no snapshot)\n");
    console.log(JSON.stringify({ running: true, responding: true }, null, 2));
    return;
  }
  process.stderr.write(
    `[prim] ✓ daemon live · pid=${snapshot.pid} · uptime=${Math.round(snapshot.uptimeMs / 1000)}s · session=${snapshot.sessionId}\n`,
  );
  console.log(JSON.stringify({ running: true, responding: true, ...snapshot }, null, 2));
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
