import { type IncomingMessage, type Server, createServer } from "node:http";
import { type AddressInfo, type Socket, connect, createServer as createTcpServer } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkTunnel,
  envProxyFor,
  onRunawayConnections,
  tunnelCheckedFetch,
  usesEnvProxy,
} from "./proxy-tunnel.js";

/**
 * A stand-in for the cloud environment's proxy. Each CONNECT is answered by
 * the next entry of `answers` (the last one repeats): a status, "close" to
 * hang up without a word, or "silent" to say nothing at all. After a 200 it
 * holds the tunnel open, as a proxy does, until the client lets go of it.
 */
type Answer = number | "close" | "silent";
let proxy: Server;
let answers: Answer[];
let asked: Array<{ authority?: string; authorization?: string }>;
// For each CONNECT in turn, whether the client has since let go of its connection.
let released: boolean[];
const held = new Set<Duplex>();

beforeEach(async () => {
  answers = [200];
  asked = [];
  released = [];
  proxy = createServer((_request, response) => {
    response.writeHead(405).end();
  });
  proxy.on("connect", (request: IncomingMessage, socket: Duplex) => {
    asked.push({ authority: request.url, authorization: request.headers["proxy-authorization"] });
    // This test's own record: a connection from an earlier test may end late.
    const record = released;
    const index = record.push(false) - 1;
    socket.once("end", () => {
      record[index] = true;
    });
    socket.resume();
    held.add(socket);
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === "close") socket.destroy();
    else if (answer === 200) socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    else if (answer !== "silent")
      socket.end(`HTTP/1.1 ${answer} Answer\r\nContent-Length: 0\r\n\r\n`);
  });
  await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
});
afterEach(async () => {
  for (const socket of held) socket.destroy();
  held.clear();
  await new Promise<void>((resolve) => proxy.close(() => resolve()));
});

const address = () => `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`;
/** The broker's environment in a cloud session: routed, with a proxy named. */
const routed = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
  NODE_USE_ENV_PROXY: "1",
  HTTPS_PROXY: address(),
  ...extra,
});
const API = new URL("https://api.example.invalid/api/cli/auth/status");

describe("usesEnvProxy", () => {
  it("is true only for a Node started to use the environment's proxy", () => {
    expect(usesEnvProxy({ NODE_USE_ENV_PROXY: "1" })).toBe(true);
    expect(usesEnvProxy({ NODE_OPTIONS: "--max-old-space-size=8192 --use-env-proxy" })).toBe(true);
    expect(usesEnvProxy({ NODE_OPTIONS: "--use-env-proxy=true" })).toBe(true);
    // A proxy is named, and nothing tells Node to use it: a cloud VM's own setting.
    expect(usesEnvProxy({ HTTPS_PROXY: "http://127.0.0.1:3128" })).toBe(false);
    expect(usesEnvProxy({ NODE_USE_ENV_PROXY: "0" })).toBe(false);
    expect(usesEnvProxy({ NODE_OPTIONS: "--use-openssl-ca --use-env-proxy-not" })).toBe(false);
  });
});

describe("envProxyFor", () => {
  const base = { NODE_USE_ENV_PROXY: "1" };
  const proxyOf = (env: NodeJS.ProcessEnv, target = API) => envProxyFor(target, env)?.href;

  it("names the proxy Node tunnels an HTTPS request through", () => {
    expect(proxyOf({ ...base, HTTPS_PROXY: "http://127.0.0.1:3128" })).toBe(
      "http://127.0.0.1:3128/",
    );
    // As Node reads them: lower case first, and HTTP's proxy when HTTPS has none.
    expect(proxyOf({ ...base, https_proxy: "http://lower:1", HTTPS_PROXY: "http://upper:2" })).toBe(
      "http://lower:1/",
    );
    expect(proxyOf({ ...base, HTTP_PROXY: "http://plain:3" })).toBe("http://plain:3/");
    expect(proxyOf({ ...base, https_proxy: "", HTTP_PROXY: "http://plain:3" })).toBe(
      "http://plain:3/",
    );
  });

  it("checks nothing where the request would not pass through a tunnel it can ask for", () => {
    const named = { ...base, HTTPS_PROXY: "http://127.0.0.1:3128" };
    // This process is not routed.
    expect(proxyOf({ HTTPS_PROXY: "http://127.0.0.1:3128" })).toBeUndefined();
    expect(proxyOf(base)).toBeUndefined();
    // Plain HTTP, which only a loopback deployment uses.
    expect(proxyOf(named, new URL("http://127.0.0.1:8080/api"))).toBeUndefined();
    // A proxy reached over TLS, or one that is not a URL.
    expect(proxyOf({ ...base, HTTPS_PROXY: "https://proxy.example:443" })).toBeUndefined();
    expect(proxyOf({ ...base, HTTPS_PROXY: "not a url" })).toBeUndefined();
    // Credentials that cannot be read are Node's to make sense of.
    expect(proxyOf({ ...base, HTTPS_PROXY: "http://user:%zz@127.0.0.1:3128" })).toBeUndefined();
    expect(proxyOf({ ...base, HTTPS_PROXY: "http://%zz:secret@127.0.0.1:3128" })).toBeUndefined();
  });

  it.each([
    ["the host", "api.example.invalid"],
    ["a parent domain", "example.invalid"],
    ["a dotted parent domain", ".example.invalid"],
    ["a wildcard parent domain", "*.example.invalid"],
    ["the host and its port", "api.example.invalid:443"],
    ["everything", "*"],
    ["a list that names it", "localhost, 127.0.0.1 api.example.invalid"],
    // Readings on which Node versions differ: any of them may leave the
    // request to Node, so each does.
    ["its port written another way", "api.example.invalid:0443"],
    ["a wildcard with no dot", "*example.invalid"],
    ["everything, within a list", "foo,*"],
  ])("leaves a request alone when NO_PROXY names %s", (_name, noProxy) => {
    const env = { ...base, HTTPS_PROXY: "http://127.0.0.1:3128" };
    expect(proxyOf({ ...env, NO_PROXY: noProxy })).toBeUndefined();
    expect(proxyOf({ ...env, no_proxy: noProxy })).toBeUndefined();
  });

  it("still checks a host NO_PROXY does not name", () => {
    const env = { ...base, HTTPS_PROXY: "http://127.0.0.1:3128" };
    for (const noProxy of ["", "localhost,127.0.0.1", "example.org", "api.example.invalid:8443"])
      expect(proxyOf({ ...env, NO_PROXY: noProxy })).toBe("http://127.0.0.1:3128/");
  });
});

describe("checkTunnel", () => {
  it.each<[Answer, string]>([
    [200, "ok"],
    [403, "PROXY_BLOCKED"],
    [407, "PROXY_407"],
    [502, "PROXY_502"],
    [503, "PROXY_503"],
    ["close", "PROXY_CLOSED"],
  ])("reads the proxy's answer %s as %s", async (answer, verdict) => {
    answers = [answer];
    expect(await checkTunnel(API, routed())).toBe(verdict);
    expect(asked).toEqual([{ authority: "api.example.invalid:443", authorization: undefined }]);
  });

  it("gives up on a proxy that says nothing", async () => {
    answers = ["silent"];
    expect(await checkTunnel(API, routed(), 150)).toBe("PROXY_TIMEOUT");
  });

  it("names why a proxy cannot be reached", async () => {
    const port = (proxy.address() as AddressInfo).port;
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
    expect(
      await checkTunnel(API, {
        NODE_USE_ENV_PROXY: "1",
        HTTPS_PROXY: `http://127.0.0.1:${port}`,
      }),
    ).toBe("PROXY_ECONNREFUSED");
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  });

  it("asks for the target's own port and presents the proxy's credentials", async () => {
    const withCredentials = address().replace("http://", "http://user%40corp:p%3Ass@");
    expect(
      await checkTunnel(new URL("https://api.example.invalid:8443/x"), {
        NODE_USE_ENV_PROXY: "1",
        https_proxy: withCredentials,
      }),
    ).toBe("ok");
    expect(asked).toEqual([
      {
        authority: "api.example.invalid:8443",
        authorization: `Basic ${Buffer.from("user@corp:p:ss").toString("base64")}`,
      },
    ]);
  });

  it("presents no credentials for a name without a password, as Node does not", async () => {
    expect(
      await checkTunnel(API, routed({ HTTPS_PROXY: address().replace("http://", "http://user@") })),
    ).toBe("ok");
    expect(asked).toEqual([{ authority: "api.example.invalid:443", authorization: undefined }]);
  });

  it("answers, never throws, for a proxy whose credentials cannot be read", async () => {
    const unreadable = address().replace("http://", "http://user:%zz@");
    await expect(checkTunnel(API, routed({ HTTPS_PROXY: unreadable }))).resolves.toBe("direct");
    expect(asked).toEqual([]);
  });

  it("stops asking the moment its caller gives up", async () => {
    answers = ["silent"];
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 100);
    expect(await checkTunnel(API, routed(), 5_000, controller.signal)).toBe("aborted");
    expect(Date.now() - started).toBeLessThan(1_500);
    // The connection is given back, not left open to a proxy that says nothing.
    await vi.waitFor(() => expect(released).toEqual([true]));
    // And nothing is asked for a caller that had already given up.
    expect(await checkTunnel(API, routed(), 5_000, controller.signal)).toBe("aborted");
    expect(asked).toHaveLength(1);
  });

  it.each<[Answer, string]>([
    [200, "ok"],
    [502, "PROXY_502"],
    ["silent", "PROXY_TIMEOUT"],
  ])("leaves no connection and no timer behind after %s", async (answer, verdict) => {
    answers = [answer];
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const asking = checkTunnel(API, routed(), 5_000);
      if (answer === "silent") {
        await vi.waitFor(() => expect(asked).toHaveLength(1));
        vi.advanceTimersByTime(5_000);
      }
      expect(await asking).toBe(verdict);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
    await vi.waitFor(() => expect(released).toEqual([true]));
  });

  it("asks no proxy where none applies", async () => {
    expect(await checkTunnel(API, { HTTPS_PROXY: address() })).toBe("direct");
    expect(await checkTunnel(API, routed({ NO_PROXY: "example.invalid" }))).toBe("direct");
    expect(asked).toEqual([]);
  });
});

describe("tunnelCheckedFetch", () => {
  const answering = () => vi.fn(async () => Response.json({ ok: true }));
  const failing = () =>
    vi.fn(async () => {
      throw new TypeError("fetch failed", { cause: new Error("Request was cancelled.") });
    });
  const codeOf = (error: unknown) => (error as { cause?: { code?: string } }).cause?.code;

  it("is fetch where no proxy applies", async () => {
    const inner = answering();
    const init = { method: "POST", body: "{}" };
    const checked = tunnelCheckedFetch({ env: { HTTPS_PROXY: address() }, fetch: inner });
    expect(await (await checked(API, init)).json()).toEqual({ ok: true });
    expect(inner).toHaveBeenCalledExactlyOnceWith(API, init);
    expect(asked).toEqual([]);
  });

  it("sends the request once the proxy has opened a tunnel for its host", async () => {
    const inner = answering();
    const checked = tunnelCheckedFetch({ env: routed(), fetch: inner });
    expect((await checked(API.href, { method: "GET" })).status).toBe(200);
    expect(inner).toHaveBeenCalledExactlyOnceWith(API.href, { method: "GET" });
    expect(asked).toHaveLength(1);
  });

  it.each<[Answer, string]>([
    [403, "PROXY_BLOCKED"],
    [502, "PROXY_502"],
    ["close", "PROXY_CLOSED"],
  ])("never hands fetch a request the proxy answers with %s", async (answer, code) => {
    answers = [answer];
    const inner = answering();
    const onSilentProxy = vi.fn();
    const failure = await tunnelCheckedFetch({ env: routed(), fetch: inner, onSilentProxy })(
      API,
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(TypeError);
    expect(codeOf(failure)).toBe(code);
    expect(inner).not.toHaveBeenCalled();
    // Nothing was handed to fetch, so nothing can be retrying.
    expect(onSilentProxy).not.toHaveBeenCalled();
  });

  it("never hands fetch a request while the proxy says nothing", async () => {
    answers = ["silent"];
    const inner = answering();
    const failure = await tunnelCheckedFetch({ env: routed(), fetch: inner, timeoutMs: 150 })(
      API,
    ).catch((error: unknown) => error);
    expect(codeOf(failure)).toBe("PROXY_TIMEOUT");
    expect(inner).not.toHaveBeenCalled();
  });

  it("does not start a request its caller has already given up on", async () => {
    const inner = answering();
    const controller = new AbortController();
    controller.abort();
    await expect(
      tunnelCheckedFetch({ env: routed(), fetch: inner })(API, { signal: controller.signal }),
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(inner).not.toHaveBeenCalled();
  });

  it("gives up with its caller during the check, not after the check's own timeout", async () => {
    answers = ["silent"];
    const inner = answering();
    const checked = tunnelCheckedFetch({ env: routed(), fetch: inner });
    const controller = new AbortController();
    let started = Date.now();
    setTimeout(() => controller.abort(), 100);
    await expect(checked(API, { signal: controller.signal })).rejects.toMatchObject({
      name: "AbortError",
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    started = Date.now();
    await expect(checked(API, { signal: AbortSignal.timeout(200) })).rejects.toMatchObject({
      name: "TimeoutError",
    });
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(inner).not.toHaveBeenCalled();
  });

  it("asks the proxy once for each request, whatever becomes of the request", async () => {
    // The check is answered; the request then fails, or takes its time.
    const failed = tunnelCheckedFetch({ env: routed(), fetch: failing() });
    await expect(failed(API)).rejects.toThrow("fetch failed");
    const slow = tunnelCheckedFetch({
      env: routed(),
      fetch: vi.fn(
        () => new Promise<Response>((resolve) => setTimeout(() => resolve(new Response()), 150)),
      ),
    });
    expect((await slow(API)).status).toBe(200);
    expect(asked).toHaveLength(2);
  });
});

describe("onRunawayConnections", () => {
  let target: ReturnType<typeof createTcpServer>;
  let stop: (() => void) | undefined;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    target = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async () => {
    stop?.();
    stop = undefined;
    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  /** Open `count` client connections, as fast as a process can. */
  function open(count: number): void {
    const { port } = target.address() as AddressInfo;
    for (let index = 0; index < count; index += 1) {
      const socket = connect(port, "127.0.0.1");
      socket.on("error", () => undefined);
      sockets.push(socket);
    }
  }

  it("reports, once, a process opening connections faster than any healthy load", () => {
    const onRunaway = vi.fn();
    stop = onRunawayConnections(onRunaway);
    // A fetch retrying a closed CONNECT opens thousands a second.
    open(700);
    expect(onRunaway).toHaveBeenCalledOnce();
    open(700);
    expect(onRunaway).toHaveBeenCalledOnce();
  });

  it("says nothing of the most a full broker opens at once", () => {
    const onRunaway = vi.fn();
    stop = onRunawayConnections(onRunaway);
    // 64 connections served, each a check and a request, and as many again.
    open(64 * 2 * 2);
    expect(onRunaway).not.toHaveBeenCalled();
  });

  it("counts a window at a time, so a steady load never adds up", async () => {
    const onRunaway = vi.fn();
    stop = onRunawayConnections(onRunaway, 10, 40);
    for (let round = 0; round < 5; round += 1) {
      open(10);
      await new Promise((resolve) => setTimeout(resolve, 60));
    }
    expect(onRunaway).not.toHaveBeenCalled();
    open(11);
    expect(onRunaway).toHaveBeenCalledOnce();
  });

  it("stops counting when told to", () => {
    const onRunaway = vi.fn();
    onRunawayConnections(onRunaway, 5)();
    open(50);
    expect(onRunaway).not.toHaveBeenCalled();
  });

  it.each<[string, Answer[], (signal: AbortSignal) => typeof fetch]>([
    [
      "a single CONNECT the proxy reset",
      [200, "close", 200],
      () =>
        (async () => {
          throw new TypeError("fetch failed", { cause: new Error("Request was cancelled.") });
        }) as typeof fetch,
    ],
    [
      "a slow, healthy answer",
      [200],
      () =>
        (() =>
          new Promise<Response>((resolve) =>
            setTimeout(() => resolve(new Response("slow")), 300),
          )) as typeof fetch,
    ],
    [
      "a caller's own abort",
      [200],
      (signal) =>
        (() =>
          new Promise<Response>((_resolve, reject) =>
            signal.addEventListener("abort", () => reject(signal.reason)),
          )) as typeof fetch,
    ],
    ["the proxy's own 502", [502], () => (async () => new Response("unreached")) as typeof fetch],
    [
      "a proxy that hangs up",
      ["close"],
      () => (async () => new Response("unreached")) as typeof fetch,
    ],
  ])("is never set off by %s", async (name, proxyAnswers, inner) => {
    const onRunaway = vi.fn();
    stop = onRunawayConnections(onRunaway);
    // Twenty such requests at once, three times over, each through the check.
    for (let round = 0; round < 3; round += 1) {
      answers = [...proxyAnswers];
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          const controller = new AbortController();
          const checked = tunnelCheckedFetch({ env: routed(), fetch: inner(controller.signal) });
          if (name === "a caller's own abort") setTimeout(() => controller.abort(), 50);
          await checked(API, { signal: controller.signal }).then(
            (response) => response.text(),
            () => undefined,
          );
        }),
      );
    }
    expect(asked).toHaveLength(60);
    expect(onRunaway).not.toHaveBeenCalled();
  });
});
