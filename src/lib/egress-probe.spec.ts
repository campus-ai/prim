import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { probeEgress } from "./egress-probe.js";
import { tunnelCheckedFetch } from "./proxy-tunnel.js";

const servers: Server[] = [];
const sockets = new Set<Duplex>();
async function listen(server: Server): Promise<string> {
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  for (const socket of sockets) socket.destroy();
  sockets.clear();
  for (const server of servers.splice(0))
    await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe("probeEgress through the cloud environment's proxy", () => {
  /** A proxy that answers each host's CONNECT as `answers` says. */
  async function proxyAnswering(answers: Record<string, number | "close" | "silent">) {
    const asked: string[] = [];
    const proxy = createServer();
    proxy.on("connect", (request, socket: Duplex) => {
      const host = (request.url ?? "").split(":")[0] ?? "";
      asked.push(host);
      const answer = answers[host] ?? 200;
      if (answer === "close") socket.destroy();
      else if (answer === "silent") sockets.add(socket);
      else socket.end(`HTTP/1.1 ${answer} Answer\r\nContent-Length: 0\r\n\r\n`);
    });
    const env = { NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: await listen(proxy) };
    return { asked, env };
  }
  // What a host answers once the proxy has let the request through.
  const origin = () =>
    vi.fn(async (input: string | URL | Request) =>
      String(input).includes("/m2m/config")
        ? Response.json({ issuer: "https://signin.example.invalid" })
        : new Response("sign-in"),
    );
  const API = "https://api.example.invalid";
  const signIn = (result: string) => ({ host: "signin.example.invalid", result });

  it("reports hosts the proxy opens a tunnel to as reachable", async () => {
    const { asked, env } = await proxyAnswering({});
    const inner = origin();
    expect(await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: inner }))).toEqual({
      api: "ok",
      signIn: signIn("ok"),
    });
    expect(asked).toEqual(["api.example.invalid", "signin.example.invalid"]);
    expect(inner).toHaveBeenCalledTimes(2);
  });

  it("reads only the proxy's 403 as a blocked host", async () => {
    const { env } = await proxyAnswering({ "api.example.invalid": 403 });
    const inner = origin();
    expect(await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: inner }))).toEqual({
      api: "blocked",
    });
    expect(inner).not.toHaveBeenCalled();
  });

  it.each([
    ["a 502 of its own", 502, "PROXY_502"],
    ["a 503 of its own", 503, "PROXY_503"],
    ["a demand for credentials", 407, "PROXY_407"],
    ["hanging up without an answer", "close", "PROXY_CLOSED"],
  ] as const)("never reads the proxy's %s as a blocked host", async (_name, answer, code) => {
    const { env } = await proxyAnswering({ "api.example.invalid": answer });
    const inner = origin();
    expect(await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: inner }))).toEqual({
      api: code,
    });
    expect(inner).not.toHaveBeenCalled();
  });

  it("asks the proxy first by default, in a process whose requests ride one", async () => {
    const { asked, env } = await proxyAnswering({ "api.example.invalid": 502 });
    vi.stubEnv("NODE_USE_ENV_PROXY", env.NODE_USE_ENV_PROXY);
    vi.stubEnv("HTTPS_PROXY", env.HTTPS_PROXY);
    vi.stubEnv("https_proxy", env.HTTPS_PROXY);
    vi.stubEnv("NO_PROXY", "");
    vi.stubEnv("no_proxy", "");
    try {
      // Plain fetch would give up on the name and call the host blocked.
      expect(await probeEgress(API, true)).toEqual({ api: "PROXY_502" });
      expect(asked).toEqual(["api.example.invalid"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("reports a proxy that says nothing as its silence, not as a host that did not answer", async () => {
    // The proxy has not said whether it would open the connection.
    const { env } = await proxyAnswering({ "api.example.invalid": "silent" });
    expect(await probeEgress(API, true, tunnelCheckedFetch({ env, timeoutMs: 150 }))).toEqual({
      api: "PROXY_TIMEOUT",
    });
  });

  it("reports that silence within its own deadlines, with nothing set for it", async () => {
    // The probe gives a host three seconds and the check gives the proxy
    // five, so it is the probe's time that runs out on a silent proxy; the
    // report must still be the proxy's silence, and come when the probe's
    // time is up.
    const { asked, env } = await proxyAnswering({ "api.example.invalid": "silent" });
    const inner = origin();
    const started = Date.now();
    expect(await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: inner }))).toEqual({
      api: "PROXY_TIMEOUT",
    });
    const took = Date.now() - started;
    expect(took).toBeGreaterThanOrEqual(2_900);
    expect(took).toBeLessThan(4_500);
    expect(asked).toEqual(["api.example.invalid"]);
    expect(inner).not.toHaveBeenCalled();
  }, 10_000);

  it("reports a sign-in host the proxy stays silent on in the same word", async () => {
    const { env } = await proxyAnswering({ "signin.example.invalid": "silent" });
    expect(
      await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: origin(), timeoutMs: 150 })),
    ).toEqual({ api: "ok", signIn: signIn("PROXY_TIMEOUT") });
  });

  it("asks nothing more once whoever wanted to know has left", async () => {
    const { asked, env } = await proxyAnswering({});
    const abandoned = new AbortController();
    const inner = vi.fn(async (_input: string | URL | Request) => {
      // The caller leaves while the API's answer is on its way.
      abandoned.abort();
      return Response.json({ issuer: "https://signin.example.invalid" });
    });
    expect(
      await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: inner }), abandoned.signal),
    ).toEqual({ api: "ok" });
    // The sign-in service is neither asked of the proxy nor requested.
    expect(asked).toEqual(["api.example.invalid"]);
    expect(inner).toHaveBeenCalledOnce();
  });

  it("gives up the request in hand when whoever wanted to know leaves", async () => {
    const { asked, env } = await proxyAnswering({ "api.example.invalid": "silent" });
    const abandoned = new AbortController();
    const inner = origin();
    setTimeout(() => abandoned.abort(), 50);
    const started = Date.now();
    // Whatever it says, nobody is there to read it: only that it stops.
    await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: inner }), abandoned.signal);
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(asked).toEqual(["api.example.invalid"]);
    expect(inner).not.toHaveBeenCalled();
  });

  it("reports a host that takes too long, once the proxy let the request through, as a timeout", async () => {
    const { env } = await proxyAnswering({});
    const slow = (async () => {
      throw new DOMException("The operation timed out", "TimeoutError");
    }) as typeof fetch;
    expect(await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: slow }))).toEqual({
      api: "timeout",
    });
  });

  it("tells the sign-in host's answer from the API's", async () => {
    const blocked = await proxyAnswering({ "signin.example.invalid": 403 });
    expect(
      await probeEgress(API, true, tunnelCheckedFetch({ env: blocked.env, fetch: origin() })),
    ).toEqual({ api: "ok", signIn: signIn("blocked") });
    const failing = await proxyAnswering({ "signin.example.invalid": 502 });
    expect(
      await probeEgress(API, true, tunnelCheckedFetch({ env: failing.env, fetch: origin() })),
    ).toEqual({ api: "ok", signIn: signIn("PROXY_502") });
  });

  it("does not take a request that fails after the tunnel opened for a blocked host", async () => {
    // What Node's fetch says of any CONNECT answer but 200: no status in it.
    const { env } = await proxyAnswering({});
    const cancelled = (async () => {
      throw new TypeError("fetch failed", { cause: new Error("Request was cancelled.") });
    }) as typeof fetch;
    expect(await probeEgress(API, true, tunnelCheckedFetch({ env, fetch: cancelled }))).toEqual({
      api: "network error",
    });
  });
});

describe("probeEgress on the network itself", () => {
  it("never follows a redirect from the host it probes", async () => {
    let elsewhere = 0;
    const other = await listen(
      createServer((_request, response) => {
        elsewhere += 1;
        response.end(JSON.stringify({ issuer: "http://127.0.0.1:1" }));
      }),
    );
    const paths: string[] = [];
    const api = await listen(
      createServer((request, response) => {
        paths.push(request.url ?? "");
        response.writeHead(302, { Location: `${other}/api/cli/auth/m2m/config` }).end();
      }),
    );
    // Any answer says the host can be reached; where it points is not asked.
    expect(await probeEgress(api, true, fetch)).toEqual({ api: "ok" });
    expect(paths).toEqual(["/api/cli/auth/m2m/config"]);
    expect(elsewhere).toBe(0);
  });
});
