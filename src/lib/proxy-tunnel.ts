import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { request } from "node:http";

const TUNNEL_TIMEOUT_MS = 5_000;
// The broker serves at most 64 connections, each good for a check and a
// request; a `fetch` retrying a closed CONNECT opens thousands a second.
const RUNAWAY_SOCKETS = 500;
const RUNAWAY_WINDOW_MS = 1_000;

/**
 * Whether this Node process sends `fetch` through the proxy its environment
 * names. Node decides at startup, so only what it was started with counts.
 */
export function usesEnvProxy(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    env.NODE_USE_ENV_PROXY === "1" ||
    /(?:^|\s)--use-env-proxy(?:=true)?(?:\s|$)/u.test(env.NODE_OPTIONS ?? "")
  );
}

/**
 * Whether NO_PROXY may exempt `target`. Node versions read an entry
 * differently (a bare name as that host only or as any name under it, `*`
 * alone or within a list, a leading `*` with or without a dot), so this takes
 * every reading at once: an entry exempts any host that ends with its name.
 * Where Node would proxy after all, the request is merely left unchecked;
 * the other mistake would ask the proxy about a host Node reaches directly.
 */
function bypassesProxy(target: URL, noProxy: string | undefined): boolean {
  const host = target.hostname.toLowerCase();
  const port = Number(target.port || 443);
  for (const entry of (noProxy ?? "").split(/[,\s]+/u)) {
    if (!entry) continue;
    const parsed = /^(.*):(\d+)$/u.exec(entry);
    if (parsed && Number(parsed[2]) !== port) continue;
    const name = (parsed?.[1] ?? entry).toLowerCase().replace(/^\*?\.?/u, "");
    if (host.endsWith(name)) return true;
  }
  return false;
}

/** The proxy's credentials as Node sends them: only a name and a password together. */
function proxyAuthorization(proxy: URL): string | undefined {
  if (!proxy.username || !proxy.password) return undefined;
  const pair = `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`;
  return `Basic ${Buffer.from(pair).toString("base64")}`;
}

/**
 * The proxy this process's `fetch` opens a tunnel through for `target`, or
 * undefined where there is nothing to check: the process is not routed, the
 * target is not HTTPS (only loopback development is, and Node versions differ
 * in how they hand plain HTTP to a proxy), NO_PROXY may exempt it, or the
 * proxy is not one a plain CONNECT reaches or its credentials cannot be
 * read. When unsure this answers undefined, which leaves the request to Node
 * as before.
 */
export function envProxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  if (!usesEnvProxy(env) || target.protocol !== "https:") return undefined;
  const named = (env.https_proxy ?? env.HTTPS_PROXY) || (env.http_proxy ?? env.HTTP_PROXY);
  if (!named || bypassesProxy(target, env.no_proxy ?? env.NO_PROXY)) return undefined;
  try {
    const proxy = new URL(named);
    proxyAuthorization(proxy);
    return proxy.protocol === "http:" ? proxy : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Ask the proxy for a tunnel to `target` and report its answer by status:
 * "ok" (200), "PROXY_BLOCKED" (403, the proxy's refusal of a host it does
 * not allow), "PROXY_<status>" for any other answer, "PROXY_CLOSED" when it
 * hangs up without one, "PROXY_TIMEOUT" when it says nothing in time, and
 * "PROXY_<code>" when it cannot be reached. "direct" where no proxy applies,
 * and "aborted" as soon as `signal` is.
 *
 * Node's `fetch` cannot be asked this. It reports every answer but 200 as the
 * same cancelled request, so a proxy outage reads as a blocked host; and on
 * Node 22 and 24 it retries a CONNECT the proxy closed without end, at
 * thousands of connections a second, whatever aborts the request.
 */
export function checkTunnel(
  target: URL,
  env: NodeJS.ProcessEnv = process.env,
  timeoutMs = TUNNEL_TIMEOUT_MS,
  signal?: AbortSignal,
): Promise<string> {
  const proxy = envProxyFor(target, env);
  if (!proxy) return Promise.resolve("direct");
  if (signal?.aborted) return Promise.resolve("aborted");
  const authority = `${target.hostname}:${target.port || "443"}`;
  const authorization = proxyAuthorization(proxy);
  return new Promise((resolve) => {
    const outgoing = request({
      host: proxy.hostname.replace(/^\[|\]$/gu, ""),
      port: proxy.port || "80",
      method: "CONNECT",
      path: authority,
      agent: false,
      headers: {
        Host: authority,
        // Never logged, and sent only to the proxy that named them.
        ...(authorization ? { "Proxy-Authorization": authorization } : {}),
      },
    });
    let settled = false;
    const settle = (verdict: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      // The tunnel was only a question; nothing is sent through it.
      outgoing.destroy();
      resolve(verdict);
    };
    const abort = () => settle("aborted");
    const answered = (status: number | undefined) =>
      settle(status === 200 ? "ok" : status === 403 ? "PROXY_BLOCKED" : `PROXY_${status ?? 0}`);
    const timer = setTimeout(() => settle("PROXY_TIMEOUT"), timeoutMs);
    signal?.addEventListener("abort", abort, { once: true });
    outgoing.once("connect", (response, socket) => {
      socket.destroy();
      answered(response.statusCode);
    });
    outgoing.once("response", (response) => {
      response.destroy();
      answered(response.statusCode);
    });
    outgoing.once("error", (error: NodeJS.ErrnoException) =>
      // A hang-up before any answer is the proxy closing the request.
      settle(
        error.code === "ECONNRESET" || !error.code
          ? "PROXY_CLOSED"
          : `PROXY_${error.code.replace(/\W/gu, "_")}`,
      ),
    );
    outgoing.once("close", () => settle("PROXY_CLOSED"));
    outgoing.end();
  });
}

/**
 * `fetch` for a process whose requests ride the environment's proxy. Each
 * request is sent only after the proxy has answered a CONNECT for its host
 * with 200; any other answer fails the request here, naming that answer as
 * the failure's code, and `fetch` is never called. That keeps a failing
 * proxy from being read as a blocked host, and keeps Node 22 and 24 from the
 * endless reconnecting described at checkTunnel while the proxy closes every
 * CONNECT. Where no proxy applies this is `fetch`.
 *
 * The check and the request are two connections, so a proxy can still answer
 * the first and close the second. Nothing here judges that: a request that
 * fails is a request that failed. A process that ends up reconnecting without
 * end is caught by what it does (see onRunawayConnections).
 */
export function tunnelCheckedFetch(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number } = {},
): typeof fetch {
  const env = options.env ?? process.env;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const signal = init?.signal ?? request?.signal;
    const target = new URL(request?.url ?? String(input));
    const verdict = await checkTunnel(target, env, options.timeoutMs, signal ?? undefined);
    signal?.throwIfAborted();
    if (verdict !== "ok" && verdict !== "direct")
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("the proxy opened no tunnel"), { code: verdict }),
      });
    return (options.fetch ?? fetch)(input, init);
  }) as typeof fetch;
}

/**
 * Call `onRunaway`, once, when this process opens client connections at a
 * rate no healthy load produces. That is how the reconnecting described at
 * checkTunnel shows itself where the check could not prevent it: the proxy
 * answered the check, then closed the request's own CONNECT. It is judged by
 * the connections alone, so no single failure, slow answer, abort, or refusal
 * can be mistaken for it. Returns how to stop watching.
 */
export function onRunawayConnections(
  onRunaway: () => void,
  limit = RUNAWAY_SOCKETS,
  windowMs = RUNAWAY_WINDOW_MS,
): () => void {
  let windowStart = 0;
  let opened = 0;
  let reported = false;
  const count = () => {
    const now = Date.now();
    if (now - windowStart >= windowMs) {
      windowStart = now;
      opened = 0;
    }
    opened += 1;
    if (opened > limit && !reported) {
      reported = true;
      onRunaway();
    }
  };
  // Published by Node for every client socket it creates, `fetch`'s included.
  subscribe("net.client.socket", count);
  return () => unsubscribe("net.client.socket", count);
}
