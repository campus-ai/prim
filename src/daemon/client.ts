/**
 * Socket client for the prim-daemon.
 *
 * Used by every hook (pre-tool-use, post-tool-use, session-start,
 * session-end) and every CLI subcommand (`prim statusline`,
 * `prim reconcile`, `prim daemon status`) to talk to the long-lived
 * `prim-daemon-server` over the socket in Primitive's resolved config directory.
 *
 * Failure model: returns `null` on any socket-side error (daemon down,
 * socket missing, timeout, malformed reply). Callers must treat null as
 * "fall through to direct HTTP" — the daemon is an accelerator, not a
 * source of truth.
 */

import { type Socket, createConnection } from "node:net";
import { join } from "node:path";
import { primConfigDirectory } from "../lib/paths.js";

const SOCK_PATH = join(primConfigDirectory(), "sock");
const DEFAULT_TIMEOUT_MS = 250;

let nextRequestId = 1;

interface DaemonRequest {
  id: number;
  method: string;
  params?: Record<string, unknown>;
}

interface DaemonResponse {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

export interface DaemonRequestOptions {
  /** Hard deadline before the call resolves with `null`. */
  timeoutMs?: number;
}

/**
 * Send a single JSON-RPC-style request to the daemon and await the
 * matching response. Returns `null` if anything fails — never throws.
 *
 * The protocol is newline-delimited JSON: one request, one response,
 * close. The daemon doesn't multiplex on a single connection, so this
 * client doesn't either.
 */
export function daemonRequest<T>(
  method: string,
  params: Record<string, unknown> = {},
  opts: DaemonRequestOptions = {},
): Promise<T | null> {
  const id = nextRequestId++;
  const request: DaemonRequest = { id, method, params };
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<T | null>((resolve) => {
    let settled = false;
    let socket: Socket | undefined;
    let buffer = "";

    const settle = (value: T | null) => {
      if (settled) {
        return;
      }
      settled = true;
      if (socket) {
        try {
          socket.destroy();
        } catch {
          // socket may already be closed
        }
      }
      resolve(value);
    };

    const timer = setTimeout(() => settle(null), timeoutMs);
    timer.unref();

    try {
      socket = createConnection(SOCK_PATH);
    } catch {
      clearTimeout(timer);
      settle(null);
      return;
    }

    socket.on("error", () => {
      clearTimeout(timer);
      settle(null);
    });

    socket.on("connect", () => {
      try {
        socket?.write(`${JSON.stringify(request)}\n`);
      } catch {
        clearTimeout(timer);
        settle(null);
      }
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf-8");
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) {
        return;
      }
      const line = buffer.slice(0, newlineIdx);
      try {
        const res = JSON.parse(line) as DaemonResponse;
        if (res.id !== id) {
          clearTimeout(timer);
          settle(null);
          return;
        }
        clearTimeout(timer);
        settle(res.ok && res.result !== undefined ? (res.result as T) : null);
      } catch {
        clearTimeout(timer);
        settle(null);
      }
    });

    socket.on("end", () => {
      if (!settled) {
        clearTimeout(timer);
        settle(null);
      }
    });
  });
}

/**
 * Lightweight "is the daemon up?" probe. Used by `prim daemon status` and
 * by the statusline. Returns `true` only if the daemon responded to a
 * `ping` within the timeout.
 */
export async function daemonIsLive(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const result = await daemonRequest<{ pong?: boolean }>("ping", {}, { timeoutMs });
  return result?.pong === true;
}
