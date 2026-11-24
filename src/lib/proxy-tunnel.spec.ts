import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { checkTunnel, envProxyFor, tunnelCheckedFetch, usesEnvProxy } from "./proxy-tunnel.js";

/**
 * A stand-in for the cloud environment's proxy. Each CONNECT is answered by
 * the next entry of `answers` (the last one repeats): a status, "close" to
 * hang up without a word, or "silent" to say nothing at all.
 */
type Answer = number | "close" | "silent";
let proxy: Server;
let answers: Answer[];
let asked: Array<{ authority?: string; authorization?: string }>;
const held = new Set<Duplex>();

beforeEach(async () => {
  answers = [200];
  asked = [];
  proxy = createServer((_request, response) => {
    response.writeHead(405).end();
  });
  proxy.on("connect", (request: IncomingMessage, socket: Duplex) => {
    asked.push({ authority: request.url, authorization: request.headers["proxy-authorization"] });
    const answer = answers.length > 1 ? answers.shift() : answers[0];
    if (answer === "close") socket.destroy();
    else if (answer === "silent") held.add(socket);
    else socket.end(`HTTP/1.1 ${answer} Answer\r\nContent-Length: 0\r\n\r\n`);
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
  });

  it.each([
    ["the host", "api.example.invalid"],
    ["a parent domain", "example.invalid"],
    ["a dotted parent domain", ".example.invalid"],
    ["a wildcard parent domain", "*.example.invalid"],
    ["the host and its port", "api.example.invalid:443"],
    ["everything", "*"],
    ["a list that names it", "localhost, 127.0.0.1 api.example.invalid"],
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

  it("reports a proxy that closes CONNECTs after a request was handed to fetch and failed", async () => {
    // The check is answered; the request's own CONNECT and every later one is closed.
    answers = [200, "close"];
    const onSilentProxy = vi.fn();
    const inner = failing();
    await expect(
      tunnelCheckedFetch({ env: routed(), fetch: inner, onSilentProxy })(API),
    ).rejects.toThrow("fetch failed");
    expect(inner).toHaveBeenCalledOnce();
    expect(onSilentProxy).toHaveBeenCalledOnce();
  });

  it("reports it while the request is still unanswered, without waiting for it to fail", async () => {
    answers = [200, "close"];
    const onSilentProxy = vi.fn();
    // As Node 22 and 24 leave it: still retrying. (There no abort stops it;
    // here one does, so the test can end.)
    const controller = new AbortController();
    const inner = vi.fn(
      (_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted"))),
        ),
    );
    const pending = tunnelCheckedFetch({
      env: routed(),
      fetch: inner,
      onSilentProxy,
      watchMs: 20,
    })(API, { signal: controller.signal });
    await vi.waitFor(() => expect(onSilentProxy).toHaveBeenCalled(), { timeout: 2_000 });
    expect(inner).toHaveBeenCalledOnce();
    controller.abort();
    await expect(pending).rejects.toThrow("aborted");
  });

  it("leaves the process alone when a request fails and the proxy still answers", async () => {
    for (const later of [200, 403, 502] as const) {
      answers = [200, later];
      const onSilentProxy = vi.fn();
      await expect(
        tunnelCheckedFetch({ env: routed(), fetch: failing(), onSilentProxy })(API),
      ).rejects.toThrow("fetch failed");
      expect(onSilentProxy).not.toHaveBeenCalled();
    }
  });

  it("stops asking the proxy once the request is answered", async () => {
    const checked = tunnelCheckedFetch({ env: routed(), fetch: answering(), watchMs: 10 });
    await checked(API);
    const afterAnswer = asked.length;
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(asked).toHaveLength(afterAnswer);
  });
});
