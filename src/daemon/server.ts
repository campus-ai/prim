#!/usr/bin/env node
/**
 * `prim-daemon-server` — long-lived per-user companion for the prim hooks.
 *
 * M4 scope: open a Unix socket at ~/.config/prim/sock that the
 * PreToolUse / SessionStart / SessionEnd hooks proxy through; amortize
 * the token-refresh check; heartbeat `agentPresence` every 30s so the
 * server can render "team: N online".
 *
 * M5 will add the reconcile bypass-token store. M6 will add the
 * ConvexClient WS subscription for the broadcast-on-capture stream.
 *
 * Lifecycle: `prim daemon start` spawns this bin detached. SIGTERM (or
 * `prim daemon stop`) cleans up the socket + pidfile. Refuses to start
 * if an existing pid is still alive.
 *
 * Fail-soft: every hook also retains its direct HTTP path. If the
 * daemon is down, hooks degrade to ~200ms instead of ~30ms; never to
 * an outright block.
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { type Socket, createServer } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { getAuthToken, getClient, getTokenExpiresAt, refreshToken } from "../client.js";

const CONFIG_DIR = join(homedir(), ".config", "prim");
const SOCK_PATH = join(CONFIG_DIR, "sock");
const PID_PATH = join(CONFIG_DIR, "daemon.pid");

const HEARTBEAT_INTERVAL_MS = 30_000;
const TOKEN_CHECK_INTERVAL_MS = 60_000;
const TOKEN_REFRESH_THRESHOLD_MS = 90_000;
const SOCKET_DIR_MODE = 0o700;
const PID_FILE_MODE = 0o600;
const EXIT_OK = 0;
const EXIT_CRASH = 1;
const FALLBACK_DISPLAY_NAME = "Anonymous";

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
let displayName = FALLBACK_DISPLAY_NAME;
let lastHeartbeatAt: number | undefined;
let heartbeatTimer: NodeJS.Timeout | undefined;
let tokenCheckTimer: NodeJS.Timeout | undefined;

function deriveDisplayName(token: string | undefined): string {
  if (!token) {
    return FALLBACK_DISPLAY_NAME;
  }
  const parts = token.split(".");
  const JWT_PARTS = 3;
  if (parts.length !== JWT_PARTS) {
    return FALLBACK_DISPLAY_NAME;
  }
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString()) as {
      name?: string;
      given_name?: string;
      email?: string;
    };
    if (payload.name) {
      return payload.name;
    }
    if (payload.given_name) {
      return payload.given_name;
    }
    if (payload.email) {
      const [local] = payload.email.split("@");
      if (local) {
        return local;
      }
    }
    return FALLBACK_DISPLAY_NAME;
  } catch {
    return FALLBACK_DISPLAY_NAME;
  }
}

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
    const result = (await client.post("/api/cli/presence/heartbeat", {
      sessionId: activeSessionId,
      displayName,
    })) as { accepted?: boolean; lastHeartbeatAt?: number };
    if (result.accepted && typeof result.lastHeartbeatAt === "number") {
      lastHeartbeatAt = result.lastHeartbeatAt;
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
  const body: Record<string, unknown> = { file: params.file };
  if (typeof params.toolName === "string") {
    body.toolName = params.toolName;
  }
  if (typeof params.fanOutThreshold === "number") {
    body.fanOutThreshold = params.fanOutThreshold;
  }
  if (params.denyReversibility === "low" || params.denyReversibility === "high") {
    body.denyReversibility = params.denyReversibility;
  }
  return await client.post("/api/cli/decisions/conflict-check", body);
}

function handleStatusSnapshot(): unknown {
  return {
    pid: process.pid,
    uptimeMs: Date.now() - startedAt,
    sessionId: activeSessionId,
    displayName,
    lastHeartbeatAt,
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
      case "session_start": {
        const sid = req.params?.sessionId;
        if (typeof sid === "string" && sid.length > 0) {
          activeSessionId = sid;
        }
        await sendHeartbeat();
        return { id, ok: true, result: { sessionId: activeSessionId } };
      }
      case "session_end": {
        // M4: keep the daemon heartbeating under its synthesized session
        // id. Per-session presence (vs per-daemon presence) lands with M6.
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
  displayName = deriveDisplayName(getAuthToken());

  try {
    takePidfile();
  } catch (err) {
    process.stderr.write(`[prim-daemon] ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(EXIT_CRASH);
  }

  installSignalHandlers();
  startSocketServer();
  startTimers();

  process.stderr.write(
    `[prim-daemon] started (pid=${process.pid}, session=${activeSessionId}, name=${displayName})\n`,
  );
}

main();
