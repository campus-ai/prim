#!/usr/bin/env node
/**
 * `prim-daemon-server` — long-lived per-user companion for the prim hooks.
 *
 * Opens a Unix socket at ~/.config/prim/sock that the PreToolUse /
 * SessionStart / SessionEnd hooks proxy through; amortizes the token-refresh
 * check; and heartbeats `agentPresence` every 30s, caching the online count
 * and the teammate-name roster the ack returns so a statusline can render
 * "team: Maya, Alex +2" (and `daemon status` the full list).
 *
 * Lifecycle: `prim daemon start` spawns this bin detached. SIGTERM (or
 * `prim daemon stop`) cleans up the socket + pidfile. Refuses to start if an
 * existing pid is still alive.
 *
 * Fail-soft: every hook also retains its direct HTTP path. If the daemon is
 * down, hooks degrade to ~200ms instead of ~30ms; never to an outright block.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { getClient, getTokenExpiresAt, refreshToken } from "../client.js";

const CONFIG_DIR = join(homedir(), ".config", "prim");
const SOCK_PATH = join(CONFIG_DIR, "sock");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

const HEARTBEAT_INTERVAL_MS = 30_000;
const TOKEN_CHECK_INTERVAL_MS = 60_000;
const TOKEN_REFRESH_THRESHOLD_MS = 90_000;
const HTTP_PROXY_TIMEOUT_MS = 10_000;
// How long cached presence (count + names) stays trustworthy after the last
// accepted heartbeat (≈ 3 heartbeat cadences). Past this, the daemon is alive
// but its heartbeats are failing, so the frozen data is reported as stale.
const PRESENCE_FRESH_WINDOW_MS = 90_000;
const SOCKET_DIR_MODE = 0o700;
const PID_FILE_MODE = 0o600;
const EXIT_OK = 0;
const EXIT_CRASH = 1;

interface SocketRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface SocketResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

const startedAt = Date.now();
const client = getClient();
let activeSessionId = process.env.PRIM_DAEMON_SESSION_ID ?? `daemon-${process.pid}`;
let lastHeartbeatAt: number | undefined;
// From the last accepted heartbeat ack, cached for the statusline /
// daemon-status to render. The server owns identity + display names (derived
// from the token); the daemon never asserts them, it only relays what the ack
// carried — `onlineCount` is the self-inclusive same-org count, `onlineNames`
// the caller's online teammates (self excluded), already deduped and sorted.
let lastOnlineCount: number | undefined;
let lastOnlineNames: string[] | undefined;
// Daemon-local timestamp of the last ACCEPTED heartbeat ack. Used to decide
// whether the cached presence (count + names) is still fresh; a daemon whose
// heartbeats are failing keeps running but stops advancing this.
let lastOkAtLocal: number | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let tokenCheckTimer: NodeJS.Timeout | undefined;

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function takePidfile(): void {
  if (existsSync(PID_PATH)) {
    const existing = Number(readFileSync(PID_PATH, "utf-8").trim());
    if (!Number.isNaN(existing) && processIsAlive(existing)) {
      throw new Error(`daemon already running (pid=${existing})`);
    }
  }
  if (!existsSync(CONFIG_DIR)) {
    mkdirSync(CONFIG_DIR, { recursive: true, mode: SOCKET_DIR_MODE });
  }
  writeFileSync(PID_PATH, String(process.pid), { mode: PID_FILE_MODE });
}

function cleanup(): void {
  try {
    unlinkSync(SOCK_PATH);
  } catch {
    // socket may already be gone; nothing to do
  }
  try {
    unlinkSync(PID_PATH);
  } catch {
    // pidfile may already be gone
  }
}

async function sendHeartbeat(): Promise<void> {
  try {
    // The body is `{ sessionId }` ONLY — the server derives identity and the
    // display names from the authenticated token. The ack carries the online
    // count and the teammate names, which we cache for the statusline and
    // daemon status.
    const result = (await client.post("/api/cli/presence/heartbeat", {
      sessionId: activeSessionId,
    })) as {
      accepted?: boolean;
      lastHeartbeatAt?: number;
      created?: boolean;
      onlineCount?: number;
      onlineNames?: string[];
      unavailable?: string;
    };
    if (result.accepted) {
      lastOkAtLocal = Date.now();
      if (typeof result.lastHeartbeatAt === "number") {
        lastHeartbeatAt = result.lastHeartbeatAt;
      }
      // Count and names ride the SAME ack — cache them atomically (clearing on
      // absence), never overwrite-only. Otherwise a names-less ack from an
      // older or rolled-back server (mixed-version deploy) advances the
      // freshness clock and updates the count while a prior roster stays
      // frozen, and the statusline would render that stale list as fresh
      // instead of falling back to the live count.
      lastOnlineCount = typeof result.onlineCount === "number" ? result.onlineCount : undefined;
      lastOnlineNames = Array.isArray(result.onlineNames) ? result.onlineNames : undefined;
    }
  } catch (err) {
    process.stderr.write(
      `[prim-daemon] heartbeat error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
  }
}

async function ensureTokenFresh(): Promise<void> {
  const expiresAt = getTokenExpiresAt();
  if (!expiresAt) {
    return;
  }
  if (Date.now() >= expiresAt - TOKEN_REFRESH_THRESHOLD_MS) {
    try {
      await refreshToken();
    } catch {
      // best-effort; the next hook call's reactive 401 path will retry
    }
  }
}

async function handleConflictCheck(params: Record<string, unknown>): Promise<unknown> {
  if (typeof params.file !== "string") {
    throw new Error("conflict_check requires `file: string`");
  }
  // The body is `{ file }` ONLY — conflict-scoring policy (fan-out /
  // reversibility thresholds) is owned entirely by the server. The daemon is
  // a transparent proxy; it forwards the path and relays the verdict verbatim.
  return await client.post("/api/cli/decisions/conflict-check", { file: params.file });
}

function pathParam(params: Record<string, unknown>): string {
  if (typeof params.path !== "string" || !params.path.startsWith("/api/cli/")) {
    throw new Error("proxy request requires `path: string` under /api/cli/");
  }
  return params.path;
}

function assertEndpointPath(path: string, endpoint: string): void {
  if (path !== endpoint && !path.startsWith(`${endpoint}?`)) {
    throw new Error(`proxy path must be ${endpoint} or ${endpoint}?...`);
  }
}

async function proxyGet(params: Record<string, unknown>, allowedPrefix: string): Promise<unknown> {
  const path = pathParam(params);
  assertEndpointPath(path, allowedPrefix);
  return await client.get(path, { signal: AbortSignal.timeout(HTTP_PROXY_TIMEOUT_MS) });
}

function handleStatusSnapshot(): unknown {
  const presenceFresh =
    lastOkAtLocal !== undefined && Date.now() - lastOkAtLocal < PRESENCE_FRESH_WINDOW_MS;
  // Stale only once we HAD an accepted ack that has since aged out — a daemon
  // that simply hasn't acked yet is not stale, just countless ("team: —").
  const presenceStale = lastOkAtLocal !== undefined && !presenceFresh;
  return {
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    sessionId: activeSessionId,
    lastHeartbeatAt,
    // Withhold a frozen count/names once they're no longer fresh; the
    // statusline shows "presence: stale" rather than a confident, wrong list.
    onlineCount: presenceFresh ? lastOnlineCount : undefined,
    onlineNames: presenceFresh ? lastOnlineNames : undefined,
    presenceStale,
  };
}

async function dispatchRequest(req: SocketRequest): Promise<SocketResponse> {
  const id = req.id;
  try {
    switch (req.method) {
      case "conflict_check": {
        const result = await handleConflictCheck(req.params ?? {});
        return { id, ok: true, result };
      }
      case "decisions_recent": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/recent");
        return { id, ok: true, result };
      }
      case "decisions_show": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/show");
        return { id, ok: true, result };
      }
      case "decisions_cascade": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/cascade");
        return { id, ok: true, result };
      }
      case "decisions_affecting": {
        const result = await proxyGet(req.params ?? {}, "/api/cli/decisions/affecting");
        return { id, ok: true, result };
      }
      case "session_start": {
        const sid = req.params?.sessionId;
        if (typeof sid === "string" && sid.length > 0) {
          activeSessionId = sid;
        }
        await sendHeartbeat();
        return { id, ok: true, result: { sessionId: activeSessionId } };
      }
      case "session_end": {
        // Keep the daemon heartbeating under its synthesized session id;
        // per-session presence is a later refinement.
        return { id, ok: true, result: { ack: true } };
      }
      case "status_snapshot":
        return { id, ok: true, result: handleStatusSnapshot() };
      case "ping":
        return { id, ok: true, result: { pong: true } };
      default:
        return { id, ok: false, error: `unknown method: ${req.method}` };
    }
  } catch (err) {
    return {
      id,
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function handleConnection(conn: Socket): void {
  let buffer = "";
  conn.on("data", (chunk) => {
    buffer += chunk.toString("utf-8");
    let newlineIdx = buffer.indexOf("\n");
    while (newlineIdx !== -1) {
      const line = buffer.slice(0, newlineIdx);
      buffer = buffer.slice(newlineIdx + 1);
      if (line.length > 0) {
        try {
          const req = JSON.parse(line) as SocketRequest;
          dispatchRequest(req).then(
            (res) => {
              conn.write(`${JSON.stringify(res)}\n`);
            },
            () => {
              // dispatcher should not throw; defensive only
            },
          );
        } catch {
          // ignore malformed envelopes — fail-soft
        }
      }
      newlineIdx = buffer.indexOf("\n");
    }
  });
  conn.on("error", () => {
    // socket clients come and go; never propagate
  });
}

function startSocketServer(): void {
  try {
    unlinkSync(SOCK_PATH);
  } catch {
    // no stale socket to remove
  }
  const server = createServer(handleConnection);
  server.on("error", (err) => {
    process.stderr.write(`[prim-daemon] socket error: ${err.message}\n`);
  });
  server.listen(SOCK_PATH, () => {
    process.stderr.write(`[prim-daemon] listening on ${SOCK_PATH}\n`);
  });
}

function startTimers(): void {
  void sendHeartbeat();
  heartbeatTimer = setInterval(() => {
    void sendHeartbeat();
  }, HEARTBEAT_INTERVAL_MS);
  tokenCheckTimer = setInterval(() => {
    void ensureTokenFresh();
  }, TOKEN_CHECK_INTERVAL_MS);
}

function stopTimers(): void {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  if (tokenCheckTimer) {
    clearInterval(tokenCheckTimer);
  }
}

function installSignalHandlers(): void {
  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => {
      process.stderr.write(`[prim-daemon] ${signal}, shutting down (pid=${process.pid})\n`);
      stopTimers();
      cleanup();
      process.exit(EXIT_OK);
    });
  }
  process.on("uncaughtException", (err) => {
    process.stderr.write(`[prim-daemon] uncaught: ${err.message}\n`);
    stopTimers();
    cleanup();
    process.exit(EXIT_CRASH);
  });
}

function main(): void {
  try {
    takePidfile();
  } catch (err) {
    process.stderr.write(`[prim-daemon] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT_CRASH);
  }

  installSignalHandlers();
  startSocketServer();
  startTimers();

  process.stderr.write(`[prim-daemon] started (pid=${process.pid}, session=${activeSessionId})\n`);
}

main();
