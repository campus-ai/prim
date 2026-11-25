import { AsyncLocalStorage } from "node:async_hooks";
import { subscribe, unsubscribe } from "node:diagnostics_channel";
import { request } from "node:http";

const TUNNEL_TIMEOUT_MS = 5_000;
// The most connections one request to the broker opens: a check and a
// request for each of discovery, the token exchange, the identity check and
// the forwarded request itself.
const CONNECTIONS_PER_REQUEST = 8;
// Connections to spare beyond that, for a reset met along the way or a
// connection that opens after its request is over.
const CONNECTIONS_TO_SPARE = 16;
// How long a spent spare connection takes to come back. Whatever opens
// connections more slowly than this, four a minute, is not reconnecting
// without end in any sense that matters, and is left alone; anything faster
// outruns it and is given up on. A spare spent to the last is whole again in
// four minutes, so stragglers over a long life do not add up.
const SPARE_RETURNS_MS = 15_000;
// How many requests whose callers left them unanswered are remembered, for
// the connection Node may yet open on their account (see connectionBudget).
const CALLERS_GONE_REMEMBERED = 16;

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
 * end is caught by what it does (see connectionBudget).
 */
export function tunnelCheckedFetch(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; timeoutMs?: number } = {},
): typeof fetch {
  const env = options.env ?? process.env;
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    const signal = init?.signal ?? request?.signal;
    const target = new URL(request?.url ?? String(input));
    let verdict = await checkTunnel(target, env, options.timeoutMs, signal ?? undefined);
    // A caller that ran out of time while the proxy still had not answered
    // met the proxy's silence, as surely as when the check's own time ran out.
    if (verdict === "aborted" && (signal?.reason as Error | undefined)?.name === "TimeoutError")
      verdict = "PROXY_TIMEOUT";
    else signal?.throwIfAborted();
    if (verdict !== "ok" && verdict !== "direct")
      throw new TypeError("fetch failed", {
        cause: Object.assign(new Error("the proxy opened no tunnel"), { code: verdict }),
      });
    return (options.fetch ?? fetch)(input, init);
  }) as typeof fetch;
}

/**
 * A request the process has accepted: how many connections it has left, and
 * whether one of them went to a connection opened in another's name.
 */
type Served = { left: number; lent: boolean };

/**
 * A budget of client connections, tied to the work this process is asked to
 * do. Every client socket Node creates, `fetch`'s included, spends one, and
 * `onOverrun` is called, once, when one opens that nothing allows for.
 *
 * There are two allowances. A request the process accepts (`accept`) is
 * good for a fixed number of connections, which are its own: but for the
 * one described below, what it leaves unused is nobody else's to spend.
 * Beyond that there are a few to spare, which no request tops up: a spent
 * one comes back only with time, slowly, by a clock that cannot be set.
 *
 * That is how the reconnecting described at checkTunnel shows itself where
 * the check could not prevent it: the proxy answered the check, then closed
 * the request's own CONNECT, and Node opens connection after connection for
 * a request that asked for a handful. It is counted, so it is caught as
 * surely when each hang-up takes a tenth of a second as when it takes none,
 * and no load of healthy requests, however fast, can look like it.
 *
 * A connection is charged to the request whose work opened it. Node carries
 * that from a request's work (`within`) to every socket opened in its
 * course, and to whatever those sockets set going in turn: the reconnecting
 * goes on in the name of the request that began it, even after that request
 * is over. So a request's connections come out of its own allowance, and a
 * runaway has its own allowance and the spare to spend, however much was
 * served before it.
 *
 * Two things keep that from ending a healthy process, and both are for one
 * event: a caller leaves, the connection its request was using is dropped,
 * and Node opens a replacement for the request waiting behind it, in the
 * name of a request that has gone. On Node 24 that is the one that left; on
 * Node 22 it is whichever first opened that line of connections, long since
 * spent. So a request's allowance stays its own after it is over (`over`).
 * And a request gives up one connection of its allowance, once, to a
 * connection opened in the name of a request that has none left: while it
 * is being served, since one connection is all it can be waiting for, and
 * afterwards if its caller left it unanswered, since it may have been
 * waiting when it was left. Only the last few such callers are remembered.
 *
 * So a runaway also takes one connection from each request served beside
 * it or abandoned of late, and is ended unless requests arrive as fast as
 * it reconnects. A request that was answered leaves it nothing.
 *
 * A connection that opens in no request's name at all, which nothing the
 * broker does should, is charged to whichever request being served has any
 * left, the newest first, and then to the spare. Were Node ever to lose
 * track of whose a connection is, a load of healthy requests would still
 * cover what they open, as long as they are being served.
 */
export function connectionBudget(
  onOverrun: () => void,
  options: {
    perRequest?: number;
    spare?: number;
    spareReturnsMs?: number;
    remembered?: number;
    /** A clock that only goes forward; a spec stands in for it. */
    now?: () => number;
  } = {},
): {
  accept: () => { within: <T>(work: () => T) => T; over: (answered?: boolean) => void };
  stop: () => void;
} {
  const perRequest = options.perRequest ?? CONNECTIONS_PER_REQUEST;
  const most = options.spare ?? CONNECTIONS_TO_SPARE;
  const returnsMs = options.spareReturnsMs ?? SPARE_RETURNS_MS;
  const now = options.now ?? (() => performance.now());
  const remembered = options.remembered ?? CALLERS_GONE_REMEMBERED;
  /** The requests being served, oldest first. */
  const serving: Served[] = [];
  /** Those whose callers left them unanswered, the latest last. */
  const abandoned: Served[] = [];
  /** The request in whose name the running code works, if any. */
  const working = new AsyncLocalStorage<Served>();
  let spare = most;
  let countedFrom = now();
  let reported = false;
  const allowed = (): boolean => {
    const own = working.getStore();
    if (own && own.left > 0) {
      own.left -= 1;
      return true;
    }
    // In another's name, a request covers one connection and no more.
    for (const requests of own ? [serving, abandoned] : [serving])
      for (let index = requests.length - 1; index >= 0; index -= 1) {
        const request = requests[index];
        if (!request || request.left === 0 || (own && request.lent)) continue;
        request.left -= 1;
        if (own) request.lent = true;
        return true;
      }
    return false;
  };
  const spend = () => {
    if (allowed()) return;
    const returned = Math.floor((now() - countedFrom) / returnsMs);
    if (returned > 0) {
      spare = Math.min(most, spare + returned);
      countedFrom += returned * returnsMs;
    }
    // A full spare saves up no time towards the next one.
    if (spare === most) countedFrom = now();
    if (spare > 0) spare -= 1;
    else if (!reported) {
      reported = true;
      onOverrun();
    }
  };
  subscribe("net.client.socket", spend);
  return {
    /**
     * A request was accepted. Its work is to run `within`, so that what it
     * opens is charged to it, and `over` says it is no longer being served,
     * and whether it was answered or its caller left first.
     */
    accept: () => {
      const request: Served = { left: perRequest, lent: false };
      serving.push(request);
      return {
        within: (work) => working.run(request, work),
        over: (answered = true) => {
          const index = serving.indexOf(request);
          if (index < 0) return;
          serving.splice(index, 1);
          if (answered) return;
          abandoned.push(request);
          if (abandoned.length > remembered) abandoned.shift();
        },
      };
    },
    stop: () => unsubscribe("net.client.socket", spend),
  };
}
