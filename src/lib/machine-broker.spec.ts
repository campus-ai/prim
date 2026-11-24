import { execFile } from "node:child_process";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { brokerEnvironment } from "./machine-broker.js";

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
    // A forward proxy that answers in the origin's place. For plain HTTP a
    // Node hands its proxy the whole request with the full URL (Node 26), or
    // opens a CONNECT tunnel first (Node 22 and 24); either is "through it".
    proxy = createServer((request, response) => {
      seen.push(new URL(request.url ?? "").host);
      response.end("through-proxy");
    });
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
