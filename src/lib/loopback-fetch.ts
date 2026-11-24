import { request } from "node:http";
import { Readable } from "node:stream";

/**
 * `fetch` for prim's own loopback services. With NODE_USE_ENV_PROXY set
 * (prim sets it for its token broker in a Claude Code cloud environment's
 * network-secret mode, and an environment may set it for every process),
 * Node's fetch sends every request through the egress proxy unless NO_PROXY
 * names the exact loopback address; a fresh agent never proxies, so prim
 * reaches its broker however NO_PROXY is spelled.
 */
export function loopbackFetch(
  url: string,
  init: {
    method?: string;
    body?: string;
    headers?: Record<string, string>;
    signal?: AbortSignal;
  } = {},
): Promise<Response> {
  const target = new URL(url);
  if (target.protocol !== "http:" || !["127.0.0.1", "[::1]", "localhost"].includes(target.hostname))
    return Promise.reject(new Error(`not a loopback URL: ${url}`));
  return new Promise((resolve, reject) => {
    const outgoing = request(
      target,
      { method: init.method ?? "GET", headers: init.headers, agent: false, signal: init.signal },
      (incoming) => {
        // A foreign server on a reused port can answer anything; a status
        // Response refuses must reject, not throw out of this callback.
        try {
          const headers = new Headers();
          for (const [name, value] of Object.entries(incoming.headers))
            if (typeof value === "string") headers.set(name, value);
          const status = incoming.statusCode ?? 502;
          const body = [101, 204, 205, 304].includes(status) ? null : Readable.toWeb(incoming);
          resolve(new Response(body as ReadableStream | null, { status, headers }));
        } catch (error) {
          incoming.destroy();
          reject(error);
        }
      },
    );
    outgoing.once("error", reject);
    outgoing.end(init.body);
  });
}
