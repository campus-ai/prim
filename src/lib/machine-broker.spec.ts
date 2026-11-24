import { execFile } from "node:child_process";
import { createHmac } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type IncomingMessage, type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  brokerEnvironment,
  createBrokerServer,
  forwardBrokerRequest,
  forwardToApi,
} from "./machine-broker.js";

const base = { directory: "/config", apiUrl: "https://api.example.com" };

describe("brokerEnvironment", () => {
  it("routes the broker through the environment's proxy only for a network secret", () => {
    const env = { PATH: "/bin", HTTPS_PROXY: "http://127.0.0.1:3128" };
    expect(
      brokerEnvironment({ ...base, env, environment: { secretInjection: "network" } }),
    ).toEqual({
      PATH: "/bin",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      PRIM_API_URL: "https://api.example.com",
      PRIM_CONFIG_DIR: "/config",
      NODE_USE_ENV_PROXY: "1",
    });
    // With the secret in the variables the token request carries it itself.
    expect(brokerEnvironment({ ...base, env, environment: {} })).toEqual({
      PATH: "/bin",
      HTTPS_PROXY: "http://127.0.0.1:3128",
      PRIM_API_URL: "https://api.example.com",
      PRIM_CONFIG_DIR: "/config",
    });
    // The caller's own environment is never changed.
    expect(env).toEqual({ PATH: "/bin", HTTPS_PROXY: "http://127.0.0.1:3128" });
  });

  it("routes the broker when the proxy holds the token too", () => {
    expect(
      brokerEnvironment({ ...base, env: {}, environment: { tokenInjection: "network" } }),
    ).toMatchObject({ NODE_USE_ENV_PROXY: "1" });
  });

  it("pins the deployment and config directory over whatever the caller carried", () => {
    const env = { PRIM_API_URL: "https://stale.example.com", PRIM_CONFIG_DIR: "/elsewhere" };
    expect(brokerEnvironment({ ...base, env, environment: {} })).toMatchObject({
      PRIM_API_URL: "https://api.example.com",
      PRIM_CONFIG_DIR: "/config",
    });
  });
});

describe("a Node process started with the broker's environment", () => {
  let proxy: Server;
  let seen: string[];

  beforeEach(async () => {
    seen = [];
    // A forward proxy that answers in the origin's place. Node's fetch opens
    // a CONNECT tunnel through its proxy even for plain HTTP.
    proxy = createServer();
    proxy.on("connect", (request, socket) => {
      seen.push(request.url ?? "");
      socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.once("data", () => {
        socket.end(
          "HTTP/1.1 200 OK\r\nContent-Length: 13\r\nConnection: close\r\n\r\nthrough-proxy",
        );
      });
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
  });
  afterEach(async () => {
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });

  /** A loopback address nothing listens on: a direct request is refused at once. */
  async function closedHost(): Promise<string> {
    const server = createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    return `127.0.0.1:${port}`;
  }

  /** What this Node's fetch does with the token service at `host` under `env`. */
  async function fetchFrom(env: NodeJS.ProcessEnv, host: string): Promise<string> {
    const script = `
      const answer = await fetch(${JSON.stringify(`http://${host}/oauth2/token`)})
        .then((response) => response.text(), () => "direct-failed");
      console.log(answer);
    `;
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      { env, encoding: "utf8", timeout: 20_000 },
    );
    return stdout.trim().split("\n").at(-1) ?? "";
  }

  // The caller's environment, as in a Claude Code cloud VM whose variables do
  // not set NODE_USE_ENV_PROXY: a proxy is named, and Node ignores it.
  const caller = (): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
    NO_PROXY: "",
    NODE_NO_WARNINGS: "1",
  });

  it("sends its token request through the proxy although the caller's Node would not", async () => {
    // With NO_PROXY empty, a routed Node hands even loopback to the proxy.
    const host = await closedHost();
    // Control: this Node, given only what the caller has, goes direct.
    expect(await fetchFrom(caller(), host)).toBe("direct-failed");
    expect(seen).toEqual([]);

    const env = brokerEnvironment({
      ...base,
      env: caller(),
      environment: { secretInjection: "network" },
    });
    expect(await fetchFrom(env, host)).toBe("through-proxy");
    expect(seen).toEqual([host]);
  });

  it("stays direct when the secret is in the variables", async () => {
    const env = brokerEnvironment({ ...base, env: caller(), environment: {} });
    expect(await fetchFrom(env, await closedHost())).toBe("direct-failed");
    expect(seen).toEqual([]);
  });
});

describe("forwardToApi (the broker's half of a forwarded request)", () => {
  const API = "https://api.example.com";
  const signal = () => new AbortController().signal;
  const answering = (response: Response = Response.json({ ok: true })) =>
    vi.fn(async (_input: string | URL | Request, _init?: RequestInit) => response);

  it("sends the request to the configured API with no credential and returns the answer", async () => {
    const fetcher = answering(
      new Response('{"decisions":[]}', {
        status: 200,
        headers: { "Content-Type": "application/json", "Set-Cookie": "session=1" },
      }),
    );
    const result = await forwardToApi(
      API,
      {
        method: "POST",
        path: "/api/cli/moves/ingest?dry=1",
        headers: {
          "Content-Type": "application/json",
          "X-Prim-Uploader-Version": "1.2.3",
          Authorization: "Bearer smuggled",
          Cookie: "a=b",
          "X-Forwarded-For": "10.0.0.1",
        },
        body: '{"moves":[]}',
      },
      signal(),
      fetcher as typeof fetch,
    );
    expect(result).toEqual({
      status: 200,
      headers: { "content-type": "application/json" },
      body: '{"decisions":[]}',
    });
    const [target, init] = fetcher.mock.calls[0] ?? [];
    expect(String(target)).toBe("https://api.example.com/api/cli/moves/ingest?dry=1");
    expect(init).toMatchObject({ method: "POST", body: '{"moves":[]}', redirect: "error" });
    // Only prim's own headers travel; the proxy attaches the token.
    expect(init?.headers).toEqual({
      "Content-Type": "application/json",
      "X-Prim-Uploader-Version": "1.2.3",
    });
  });

  it("passes an API refusal through as the API's answer", async () => {
    const result = await forwardToApi(
      API,
      { method: "GET", path: "/api/cli/auth/status", body: "ignored" },
      signal(),
      answering(
        new Response("{}", { status: 401, headers: { "Retry-After": "30" } }),
      ) as typeof fetch,
    );
    expect(result).toMatchObject({ status: 401, headers: { "retry-after": "30" }, body: "{}" });
  });

  it("sends no body with a GET", async () => {
    const fetcher = answering();
    await forwardToApi(
      API,
      { method: "GET", path: "/x", body: "ignored" },
      signal(),
      fetcher as typeof fetch,
    );
    expect(fetcher.mock.calls[0]?.[1]?.body).toBeUndefined();
  });

  it.each([
    ["another host by scheme-relative path", "//evil.example.com/api"],
    ["another host by backslashes", "/\\evil.example.com/api"],
    ["an absolute URL", "https://evil.example.com/api"],
    ["a relative path", "api/cli/auth/status"],
    ["no path", undefined],
  ])("never sends the request to %s", async (_name, path) => {
    const fetcher = answering();
    const result = await forwardToApi(
      API,
      { method: "GET", path },
      signal(),
      fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ error: { code: "invalid_request" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([["PUT"], ["CONNECT"], ["get"], [undefined]])("refuses method %s", async (method) => {
    const fetcher = answering();
    const result = await forwardToApi(
      API,
      { method, path: "/api" },
      signal(),
      fetcher as typeof fetch,
    );
    expect(result).toMatchObject({ error: { code: "invalid_request" } });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("reports an unreachable API without leaking the failure", async () => {
    const result = await forwardToApi(API, { method: "GET", path: "/api" }, signal(), (async () => {
      throw new TypeError("fetch failed", { cause: new Error("proxy says: secret-ish detail") });
    }) as typeof fetch);
    expect(result).toEqual({
      error: {
        code: "authentication_unavailable",
        message: expect.stringContaining("through the cloud environment's proxy"),
        terminal: false,
      },
    });
  });

  it("refuses an answer larger than prim accepts", async () => {
    const result = await forwardToApi(
      API,
      { method: "GET", path: "/api" },
      signal(),
      answering(new Response("x".repeat(8 * 1024 * 1024 + 1))) as typeof fetch,
    );
    // Not toMatchObject: a failure would print the whole body.
    expect((result as { error?: { code?: string } }).error?.code).toBe("invalid_response");
  });
});

describe("forwarding through a running broker", () => {
  const KEY = "a".repeat(64);
  const NONCE = "b".repeat(64);
  const GENERATION = "c".repeat(64);
  const environment = {
    clientId: "client_cloud",
    clientSecret: KEY,
    generation: GENERATION,
    tokenInjection: "network" as const,
  };
  let directory: string;
  let api: Server;
  let broker: Server;
  let apiUrl: string;
  let received: Array<{
    method?: string;
    url?: string;
    headers: IncomingMessage["headers"];
    body: string;
  }>;
  let answer: { status: number; body?: string; headers?: Record<string, string> };

  const listen = (server: Server) =>
    new Promise<number>((resolve) =>
      server.listen(0, "127.0.0.1", () => resolve((server.address() as AddressInfo).port)),
    );
  const close = (server?: Server) =>
    new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));

  /** Start a broker for `mode` and publish its descriptor where callers look. */
  async function startBroker(
    mode: typeof environment | Omit<typeof environment, "tokenInjection">,
  ) {
    broker = createBrokerServer({ environment: mode, apiUrl, nonce: NONCE });
    const port = await listen(broker);
    writeFileSync(
      join(directory, `machine_broker_${GENERATION}.json`),
      JSON.stringify({ port, pid: process.pid, nonce: NONCE }),
      { mode: 0o600 },
    );
    return port;
  }

  const forward = (
    request: { method: string; path: string; headers?: Record<string, string>; body?: string },
    as: { clientSecret: string } = environment,
  ) =>
    forwardBrokerRequest({
      directory,
      apiUrl,
      environment: { ...environment, ...as },
      env: {},
      request,
      signal: AbortSignal.timeout(5_000),
    });

  /** A hand-built request, to present proofs the client itself never would. */
  async function raw(port: number, path: string, body: string, purpose?: string): Promise<number> {
    const proof = createHmac("sha256", KEY)
      .update(purpose ? `${NONCE}\0${purpose}\0${body}` : `${NONCE}\0${body}`)
      .digest("hex");
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      body,
      headers: { "Content-Type": "application/json", "X-Prim-Proof": proof },
    });
    await response.arrayBuffer();
    return response.status;
  }
  const envelope = (extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      generation: GENERATION,
      timestamp: Date.now(),
      method: "GET",
      path: "/api/cli/auth/status",
      headers: {},
      ...extra,
    });

  beforeEach(async () => {
    directory = mkdtempSync(join(tmpdir(), "prim-broker-forward-"));
    received = [];
    answer = { status: 200, body: '{"ok":true}', headers: { "Content-Type": "application/json" } };
    api = createServer(async (request, response) => {
      let body = "";
      for await (const chunk of request) body += chunk;
      received.push({ method: request.method, url: request.url, headers: request.headers, body });
      response.writeHead(answer.status, answer.headers);
      response.end(answer.body);
    });
    apiUrl = `http://127.0.0.1:${await listen(api)}`;
  });
  afterEach(async () => {
    await close(broker);
    await close(api);
    rmSync(directory, { recursive: true, force: true });
  });

  it("carries a request to the API and its answer back, with no credential added", async () => {
    await startBroker(environment);
    answer = {
      status: 201,
      body: '{"saved":"décision ✓"}',
      headers: { "Content-Type": "application/json", "Retry-After": "7" },
    };
    const response = await forward({
      method: "POST",
      path: "/api/cli/moves/ingest",
      headers: { "Content-Type": "application/json", "X-Prim-Uploader-Version": "1.2.3" },
      body: '{"note":"naïve — ✓"}',
    });
    expect(response.status).toBe(201);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(await response.json()).toEqual({ saved: "décision ✓" });
    expect(received).toHaveLength(1);
    expect(received[0]).toMatchObject({
      method: "POST",
      url: "/api/cli/moves/ingest",
      body: '{"note":"naïve — ✓"}',
    });
    expect(received[0]?.headers["x-prim-uploader-version"]).toBe("1.2.3");
    expect(received[0]?.headers.authorization).toBeUndefined();
  });

  it("returns the API's refusals and empty answers as they are", async () => {
    await startBroker(environment);
    answer = { status: 401, body: "{}" };
    expect((await forward({ method: "GET", path: "/api/cli/auth/status" })).status).toBe(401);
    answer = { status: 204 };
    const empty = await forward({ method: "DELETE", path: "/api/cli/x" });
    expect(empty.status).toBe(204);
    expect(await empty.text()).toBe("");
  });

  it("does nothing for a caller without the peers' key", async () => {
    await startBroker(environment);
    await expect(
      forward({ method: "GET", path: "/api/cli/auth/status" }, { clientSecret: "d".repeat(64) }),
    ).rejects.toMatchObject({ code: "broker_unavailable" });
    expect(received).toEqual([]);
  });

  it("keeps forwarding and credential proofs apart, and refuses stale or foreign requests", async () => {
    const port = await startBroker(environment);
    // The proof a real forward carries is accepted...
    expect(await raw(port, "/forward", envelope(), "forward-request")).toBe(200);
    // ...a credential-style proof is not, nor is an answer's, and a forward
    // proof opens nothing at /credential.
    expect(await raw(port, "/forward", envelope())).toBe(403);
    expect(await raw(port, "/forward", envelope(), "forward-answer")).toBe(403);
    expect(await raw(port, "/credential", envelope(), "forward-request")).toBe(403);
    // Correctly signed, but old or for another generation.
    expect(
      await raw(port, "/forward", envelope({ timestamp: Date.now() - 60_000 }), "forward-request"),
    ).toBe(403);
    expect(
      await raw(port, "/forward", envelope({ generation: "e".repeat(64) }), "forward-request"),
    ).toBe(403);
    expect(received).toHaveLength(1);
  });

  it("does not exist on a broker whose callers hold their own token", async () => {
    const { tokenInjection: _mode, ...holdsToken } = environment;
    const port = await startBroker(holdsToken);
    expect(await raw(port, "/forward", envelope(), "forward-request")).toBe(404);
    expect(received).toEqual([]);
  });
});
