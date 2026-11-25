import { type IncomingMessage, type Server, createServer } from "node:http";
import { type AddressInfo, type Socket, connect, createServer as createTcpServer } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  checkTunnel,
  connectionBudget,
  envProxyFor,
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
    // A caller whose own time runs out while the proxy has yet to answer is
    // told that: the proxy did not answer in time, whoever was counting.
    started = Date.now();
    const outOfTime = await checked(API, { signal: AbortSignal.timeout(200) }).catch(
      (error: unknown) => error,
    );
    expect(outOfTime).toBeInstanceOf(TypeError);
    expect(codeOf(outOfTime)).toBe("PROXY_TIMEOUT");
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(inner).not.toHaveBeenCalled();
  });

  it("leaves a caller's time running out to the request once the proxy has answered", async () => {
    // Then it is the host that is slow, which is another thing to be told.
    const slow = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
    );
    await expect(
      tunnelCheckedFetch({ env: routed(), fetch: slow })(API, { signal: AbortSignal.timeout(150) }),
    ).rejects.toMatchObject({ name: "TimeoutError" });
    expect(slow).toHaveBeenCalledOnce();
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

describe("connectionBudget", () => {
  let target: ReturnType<typeof createTcpServer>;
  let budget: ReturnType<typeof connectionBudget> | undefined;
  const sockets: Socket[] = [];

  beforeEach(async () => {
    target = createTcpServer((socket) => socket.destroy());
    await new Promise<void>((resolve) => target.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async () => {
    budget?.stop();
    budget = undefined;
    for (const socket of sockets.splice(0)) socket.destroy();
    await new Promise<void>((resolve) => target.close(() => resolve()));
  });

  /** Open `count` client connections, as a request's work or a runaway does. */
  function open(count: number): void {
    const { port } = target.address() as AddressInfo;
    for (let index = 0; index < count; index += 1) {
      const socket = connect(port, "127.0.0.1");
      socket.on("error", () => undefined);
      sockets.push(socket);
    }
  }
  const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Open connections one at a time until the budget is overrun; how many it took. */
  function until(onOverrun: ReturnType<typeof vi.fn>, most = 1_000): number {
    let opened = 0;
    while (onOverrun.mock.calls.length === 0 && opened < most) {
      opened += 1;
      open(1);
    }
    return opened;
  }

  it("allows a request the connections its work can take, and a few to spare", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    const request = budget.accept();
    // A check and a request each for discovery, the exchange, the identity
    // check and the request forwarded; then a reset or two along the way.
    request.within(() => open(8 + 16));
    expect(onOverrun).not.toHaveBeenCalled();
    request.over();
  });

  it("gives up on the twenty-fifth connection of a request that asked for a handful", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    const request = budget.accept();
    request.within(() => open(24));
    expect(onOverrun).not.toHaveBeenCalled();
    request.within(() => open(1));
    expect(onOverrun).toHaveBeenCalledOnce();
    // Once is enough: the process is ending.
    request.within(() => open(500));
    expect(onOverrun).toHaveBeenCalledOnce();
  });

  it.each([0, 3, 10, 100])(
    "gives up after the same number of connections when each hang-up takes %i ms",
    async (hangUpMs) => {
      let opened = 0;
      let openedAtOverrun: number | undefined;
      budget = connectionBudget(() => {
        openedAtOverrun = opened;
      });
      // A loop is sequential: the next connection follows the last one's
      // hang-up, however long that took. No rate is too slow to be counted.
      await budget.accept().within(async () => {
        while (openedAtOverrun === undefined && opened < 200) {
          opened += 1;
          open(1);
          if (hangUpMs > 0 && opened < 30 && opened % 8 === 0) await pause(hangUpMs);
        }
      });
      expect(openedAtOverrun).toBe(25);
    },
  );

  it("is not moved by the wall clock, whichever way it is set", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    const request = budget.accept();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now");
    try {
      request.within(() => open(12));
      clock.mockReturnValue(now - 3_600_000);
      request.within(() => open(12));
      clock.mockReturnValue(now + 86_400_000);
      expect(onOverrun).not.toHaveBeenCalled();
      request.within(() => open(1));
      expect(onOverrun).toHaveBeenCalledOnce();
    } finally {
      clock.mockRestore();
    }
  });

  it("covers sixty-four callers at once, each cold", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    const requests = Array.from({ length: 64 }, () => budget?.accept());
    // Every connection a request can take, for every one of them.
    for (const request of requests) request?.within(() => open(8));
    expect(onOverrun).not.toHaveBeenCalled();
    for (const request of requests) request?.over();
    // And none of it out of what is kept to spare.
    open(16);
    expect(onOverrun).not.toHaveBeenCalled();
    open(1);
    expect(onOverrun).toHaveBeenCalledOnce();
  });

  it("never mistakes a load of healthy requests for a runaway, however fast or long", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    // Eight callers at a time, as fast as they can go: a check and a request each.
    for (let round = 0; round < 1_000; round += 1) {
      const requests = Array.from({ length: 8 }, () => budget?.accept());
      for (const request of requests) request?.within(() => open(2));
      for (const request of requests) request?.over();
      for (const socket of sockets.splice(0)) socket.destroy();
    }
    expect(onOverrun).not.toHaveBeenCalled();
  });

  it("banks nothing from finished requests for a runaway to spend", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    // A long and frugal life: ten thousand requests, one connection each.
    for (let served = 0; served < 10_000; served += 1) {
      const request = budget.accept();
      request.within(() => open(1));
      request.over();
      // Saying a request is over twice takes nothing away twice.
      request.over();
      for (const socket of sockets.splice(0)) socket.destroy();
    }
    // Then one request whose connections never stop.
    expect(budget.accept().within(() => until(onOverrun))).toBe(25);
  });

  it("gives a runaway one connection from each request served beside it, and no more", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    // One request starts reconnecting and uses up what it was good for.
    const runaway = budget.accept();
    runaway.within(() => open(8));
    // Healthy requests come and go meanwhile, each leaving most of its
    // allowance unused, and the runaway opens three connections while each
    // of them is being served.
    let opened = 8;
    for (let served = 0; served < 500 && onOverrun.mock.calls.length === 0; served += 1) {
      const healthy = budget.accept();
      healthy.within(() => open(2));
      for (let again = 0; again < 3 && onOverrun.mock.calls.length === 0; again += 1) {
        opened += 1;
        runaway.within(() => open(1));
      }
      healthy.over();
      for (const socket of sockets.splice(0)) socket.destroy();
    }
    // One from each request that passed, two from the spare: eight requests
    // empty it, and the ninth has only its one to give.
    expect(opened).toBe(8 + 8 * 3 + 2);
    expect(onOverrun).toHaveBeenCalledOnce();
  });

  it("leaves a request that covered another's connection the rest of its own", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun, { spare: 0 });
    const spent = budget.accept();
    spent.within(() => open(8));
    const waiting = budget.accept();
    // The connection the waiting request needs, opened in the other's name.
    spent.within(() => open(1));
    expect(onOverrun).not.toHaveBeenCalled();
    waiting.within(() => open(7));
    expect(onOverrun).not.toHaveBeenCalled();
    waiting.within(() => open(1));
    expect(onOverrun).toHaveBeenCalledOnce();
  });

  it("is lent nothing by its own request, nor by one that is over", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    const others = Array.from({ length: 63 }, () => budget?.accept());
    for (const other of others) other?.over();
    const runaway = budget.accept();
    expect(runaway.within(() => until(onOverrun))).toBe(8 + 16 + 1);
  });

  it("leaves a healthy request its own allowance while a runaway spends the spare", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    const runaway = budget.accept();
    runaway.within(() => open(8 + 16));
    // Every connection the cold request beside it can take is still its own.
    const healthy = budget.accept();
    healthy.within(() => open(8));
    expect(onOverrun).not.toHaveBeenCalled();
  });

  it("goes on charging a request for what its work set going, by itself and after it", async () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    const request = budget.accept();
    // As Node's reconnecting does: each connection sets the next one going,
    // and none of it waits for the request that began it, or ends with it.
    let opened = 0;
    await new Promise<void>((resolve) =>
      request.within(() => {
        const again = () => {
          if (onOverrun.mock.calls.length > 0 || opened >= 200) return resolve();
          opened += 1;
          open(1);
          // Its caller leaves after the fourth.
          if (opened === 4) request.over();
          setImmediate(again);
        };
        setImmediate(again);
      }),
    );
    // Its own allowance and the spare, as if it were still being served:
    // no more for being over, and no less.
    expect(opened).toBe(8 + 16 + 1);
  });

  it("covers what opens in the name of callers that left, each out of what that caller left", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    // A caller leaves with a request already waiting on its connection, and
    // Node 24 opens the replacement in the name of the one that left: four
    // hundred times over, and none of it out of the spare.
    for (let caller = 0; caller < 400; caller += 1) {
      const request = budget.accept();
      request.within(() => open(2));
      request.over();
      request.within(() => open(2));
      for (const socket of sockets.splice(0)) socket.destroy();
    }
    expect(onOverrun).not.toHaveBeenCalled();
    open(16);
    expect(onOverrun).not.toHaveBeenCalled();
    open(1);
    expect(onOverrun).toHaveBeenCalledOnce();
  });

  it("covers what opens in a long-spent request's name for a caller that left unanswered", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    const first = budget.accept();
    first.within(() => open(8));
    first.over();
    // Each caller leaves at once, and the replacement its request was
    // waiting for opens after it has gone, with nobody being served.
    for (let caller = 0; caller < 400; caller += 1) {
      const gone = budget.accept();
      gone.within(() => open(1));
      gone.over(false);
      first.within(() => open(1));
      for (const socket of sockets.splice(0)) socket.destroy();
    }
    expect(onOverrun).not.toHaveBeenCalled();
  });

  it("remembers only the last sixteen callers that left, and nothing of one that was answered", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    for (let caller = 0; caller < 100; caller += 1) budget.accept().over(false);
    for (let caller = 0; caller < 100; caller += 1) budget.accept().over(true);
    // A runaway after them all: its own, one from each of the sixteen, and
    // the spare.
    expect(budget.accept().within(() => until(onOverrun))).toBe(8 + 16 + 16 + 1);
  });

  it("takes a request for over once, however often it is said", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun, { spare: 0 });
    const spent = budget.accept();
    spent.within(() => open(8));
    const answered = budget.accept();
    answered.over(true);
    // Said again as if its caller had left: it was answered, and lends nothing.
    answered.over(false);
    spent.within(() => open(1));
    expect(onOverrun).toHaveBeenCalledOnce();
  });

  it("covers what opens in a long-spent request's name for each request that waits on it", () => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    // Node 22 opens every such replacement in the name of the request that
    // first opened that line of connections, which has long had none left.
    const first = budget.accept();
    first.within(() => open(8));
    first.over();
    for (let caller = 0; caller < 400; caller += 1) {
      const waiting = budget.accept();
      waiting.within(() => open(1));
      first.within(() => open(1));
      waiting.within(() => open(1));
      waiting.over();
      for (const socket of sockets.splice(0)) socket.destroy();
    }
    expect(onOverrun).not.toHaveBeenCalled();
    // And once more with nobody waiting: that one is the spare's.
    first.within(() => open(16));
    expect(onOverrun).not.toHaveBeenCalled();
    first.within(() => open(1));
    expect(onOverrun).toHaveBeenCalledOnce();
  });

  describe("with Node's own fetch", () => {
    let origin: Server;
    let url: string;
    beforeEach(async () => {
      // Each answer ends its connection, so each request opens one.
      origin = createServer((_request, response) => {
        response.setHeader("Connection", "close");
        response.end("ok");
      });
      await new Promise<void>((resolve) => origin.listen(0, "127.0.0.1", resolve));
      url = `http://127.0.0.1:${(origin.address() as AddressInfo).port}/`;
    });
    afterEach(async () => {
      origin.closeAllConnections();
      await new Promise<void>((resolve) => origin.close(() => resolve()));
    });
    const ask = async () => (await fetch(url)).text();

    it("charges the connection a fetch opens to the request that asked", async () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { perRequest: 1, spare: 0 });
      // Over already, so nothing covers the connection but its being this
      // request's own: were it opened in no name, it would be nobody's.
      const asked = budget.accept();
      asked.over();
      expect(await asked.within(ask)).toBe("ok");
      expect(onOverrun).not.toHaveBeenCalled();
      await asked.within(ask);
      expect(onOverrun).toHaveBeenCalledOnce();
    });

    it("charges each of many requests at once for its own, and no other's", async () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { perRequest: 3, spare: 0 });
      await Promise.all(
        Array.from({ length: 24 }, async () => {
          const request = budget?.accept();
          request?.over();
          // Three connections each, one after the other: all it is good for.
          await request?.within(async () => {
            for (let asked = 0; asked < 3; asked += 1) await ask();
          });
        }),
      );
      expect(onOverrun).not.toHaveBeenCalled();
    });
  });

  describe("a connection opened in no request's name", () => {
    it("is charged to the newest request in hand that has any left, then to the spare", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun);
      // An older request is still at work when a newer one comes and goes.
      const older = budget.accept();
      const newer = budget.accept();
      open(8);
      newer.over();
      // The older one has all of its own left.
      open(8);
      older.over();
      open(16);
      expect(onOverrun).not.toHaveBeenCalled();
      open(1);
      expect(onOverrun).toHaveBeenCalledOnce();
    });

    it("is covered by the requests in hand only while they are served", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun);
      const requests = Array.from({ length: 64 }, () => budget?.accept());
      open(40);
      expect(onOverrun).not.toHaveBeenCalled();
      // What they had left goes with them.
      for (const request of requests) request?.over();
      expect(until(onOverrun)).toBe(17);
    });

    it("is covered by nobody whose caller has left", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { spare: 0 });
      // Remembered for the one connection Node may open in a request's
      // name on its account, and for nothing else.
      budget.accept().over(false);
      open(1);
      expect(onOverrun).toHaveBeenCalledOnce();
    });

    it("is not charged to a request whose own work opened it", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { spare: 0 });
      const request = budget.accept();
      const other = budget.accept();
      // In the first request's name: its eight, and not the other's.
      request.within(() => open(8));
      expect(onOverrun).not.toHaveBeenCalled();
      // In nobody's: the other's eight cover these.
      open(8);
      expect(onOverrun).not.toHaveBeenCalled();
      other.within(() => open(1));
      expect(onOverrun).toHaveBeenCalledOnce();
    });
  });

  describe("what is kept to spare", () => {
    let clock = 0;
    const now = () => clock;
    beforeEach(() => {
      clock = 1_000_000;
    });

    it("comes back one connection each fifteen seconds, and no faster", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { now });
      open(16);
      clock += 15_000;
      open(1);
      expect(onOverrun).not.toHaveBeenCalled();
      open(1);
      expect(onOverrun).toHaveBeenCalledOnce();
    });

    it("is spent to the last before the time since counts for nothing", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { now });
      open(16);
      clock += 14_999;
      open(1);
      expect(onOverrun).toHaveBeenCalledOnce();
    });

    it("never holds more than sixteen, however long nothing is spent", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { now });
      open(16);
      clock += 86_400_000;
      open(16);
      expect(onOverrun).not.toHaveBeenCalled();
      open(1);
      expect(onOverrun).toHaveBeenCalledOnce();
    });

    it("saves up no time while it is full", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { now });
      // Fourteen quiet seconds earn nothing towards the next one back.
      clock += 14_000;
      open(16);
      clock += 1_500;
      open(1);
      expect(onOverrun).toHaveBeenCalledOnce();
    });

    it("lets through what opens connections no faster than they come back", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun, { now });
      // Four a minute, for a day: not a process out of control.
      for (let opened = 0; opened < 5_760; opened += 1) {
        clock += 15_000;
        open(1);
        for (const socket of sockets.splice(0)) socket.destroy();
      }
      expect(onOverrun).not.toHaveBeenCalled();
    });

    it("still gives up on a runaway that takes half a second, or a second and a half, over each", () => {
      for (const hangUpMs of [500, 1_500]) {
        const onOverrun = vi.fn();
        const slow = connectionBudget(onOverrun, { now });
        let opened = 0;
        slow.accept().within(() => {
          while (onOverrun.mock.calls.length === 0 && opened < 1_000) {
            opened += 1;
            clock += hangUpMs;
            open(1);
          }
        });
        slow.stop();
        for (const socket of sockets.splice(0)) socket.destroy();
        // Its allowance, the spare, and the little that came back meanwhile.
        expect(opened).toBeGreaterThanOrEqual(25);
        expect(opened).toBeLessThanOrEqual(28);
      }
    });

    it("is not moved by the wall clock", () => {
      const onOverrun = vi.fn();
      budget = connectionBudget(onOverrun);
      open(16);
      const wall = vi.spyOn(Date, "now").mockReturnValue(Date.now() + 86_400_000);
      try {
        open(1);
        expect(onOverrun).toHaveBeenCalledOnce();
      } finally {
        wall.mockRestore();
      }
    });
  });

  it("spends nothing once stopped", () => {
    const onOverrun = vi.fn();
    connectionBudget(onOverrun).stop();
    open(100);
    expect(onOverrun).not.toHaveBeenCalled();
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
  ])("is never overrun by %s", async (name, proxyAnswers, inner) => {
    const onOverrun = vi.fn();
    budget = connectionBudget(onOverrun);
    // Twenty such requests at once, three times over, each through the check.
    for (let round = 0; round < 3; round += 1) {
      answers = [...proxyAnswers];
      await Promise.all(
        Array.from({ length: 20 }, async () => {
          const request = budget?.accept();
          const controller = new AbortController();
          const checked = tunnelCheckedFetch({ env: routed(), fetch: inner(controller.signal) });
          if (name === "a caller's own abort") setTimeout(() => controller.abort(), 50);
          await request?.within(() =>
            checked(API, { signal: controller.signal }).then(
              (response) => response.text(),
              () => undefined,
            ),
          );
          request?.over();
        }),
      );
    }
    // Each asked the proxy once, unless its caller had left before it could.
    if (name === "a caller's own abort") expect(asked.length).toBeLessThanOrEqual(60);
    else expect(asked).toHaveLength(60);
    expect(onOverrun).not.toHaveBeenCalled();
  });
});
