import { request } from "node:http";

const TUNNEL_TIMEOUT_MS = 5_000;
const WATCH_MS = 1_000;

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

/** NO_PROXY as any supported Node may read it: a name, or any name under it. */
function bypassesProxy(target: URL, noProxy: string | undefined): boolean {
  const host = target.hostname.toLowerCase();
  const port = target.port || "443";
  for (const entry of (noProxy ?? "").split(/[,\s]+/u)) {
    if (!entry) continue;
    if (entry === "*") return true;
    const parsed = /^(.+):(\d+)$/u.exec(entry);
    if (parsed && parsed[2] !== port) continue;
    const name = (parsed?.[1] ?? entry).toLowerCase().replace(/^\*?\./u, "");
    if (host === name || host.endsWith(`.${name}`)) return true;
  }
  return false;
}

/**
 * The proxy this process's `fetch` opens a tunnel through for `target`, or
 * undefined where there is nothing to check: the process is not routed, the
 * target is not HTTPS (only loopback development is, and Node versions differ
 * in how they hand plain HTTP to a proxy), NO_PROXY may exempt it, or the
 * proxy is not one a plain CONNECT reaches. When unsure this answers
 * undefined, which leaves the request to Node as before.
 */
export function envProxyFor(target: URL, env: NodeJS.ProcessEnv = process.env): URL | undefined {
  if (!usesEnvProxy(env) || target.protocol !== "https:") return undefined;
  const named = (env.https_proxy ?? env.HTTPS_PROXY) || (env.http_proxy ?? env.HTTP_PROXY);
  if (!named || bypassesProxy(target, env.no_proxy ?? env.NO_PROXY)) return undefined;
  try {
    const proxy = new URL(named);
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
 * "PROXY_<code>" when it cannot be reached. "direct" where no proxy applies.
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
): Promise<string> {
  const proxy = envProxyFor(target, env);
  if (!proxy) return Promise.resolve("direct");
  const authority = `${target.hostname}:${target.port || "443"}`;
  return new Promise((resolve) => {
    const outgoing = request({
      host: proxy.hostname.replace(/^\[|\]$/gu, ""),
      port: proxy.port || "80",
      method: "CONNECT",
      path: authority,
      agent: false,
      headers: {
        Host: authority,
        // As Node sends them; never logged, and only to the proxy that named them.
        ...(proxy.username
          ? {
              "Proxy-Authorization": `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}`,
            }
          : {}),
      },
    });
    let settled = false;
    const settle = (verdict: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // The tunnel was only a question; nothing is sent through it.
      outgoing.destroy();
      resolve(verdict);
    };
    const answered = (status: number | undefined) =>
      settle(status === 200 ? "ok" : status === 403 ? "PROXY_BLOCKED" : `PROXY_${status ?? 0}`);
    const timer = setTimeout(() => settle("PROXY_TIMEOUT"), timeoutMs);
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
 * endless reconnecting described at checkTunnel.
 *
 * The check and the request are two connections, so a proxy can answer the
 * first and close the second. While a request is unanswered the proxy is
 * asked again every second, and once more if the request fails; when it is
 * found closing CONNECTs, `onSilentProxy` is called. That `fetch` may be
 * retrying inside this process, where no abort reaches it, and only the
 * process ending stops it. Where no proxy applies this is `fetch`.
 */
export function tunnelCheckedFetch(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    timeoutMs?: number;
    watchMs?: number;
    onSilentProxy?: () => void;
  } = {},
): typeof fetch {
  const env = options.env ?? process.env;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const target = new URL(input instanceof Request ? input.url : String(input));
    const verdict = await checkTunnel(target, env, options.timeoutMs);
    if (verdict === "direct") return (options.fetch ?? fetch)(input, init);
    if (verdict !== "ok")
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("the proxy opened no tunnel"), { code: verdict }),
      });
    init?.signal?.throwIfAborted();
    let asking = false;
    const ask = async () => {
      if (asking) return;
      asking = true;
      const closed = (await checkTunnel(target, env, options.timeoutMs)) === "PROXY_CLOSED";
      asking = false;
      if (closed) options.onSilentProxy?.();
    };
    const watch = setInterval(() => void ask(), options.watchMs ?? WATCH_MS);
    watch.unref();
    try {
      return await (options.fetch ?? fetch)(input, init);
    } catch (error) {
      await ask();
      throw error;
    } finally {
      clearInterval(watch);
    }
  }) as typeof fetch;
}
