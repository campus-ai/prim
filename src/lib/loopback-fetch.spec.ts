import { execFile } from "node:child_process";
import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loopbackFetch } from "./loopback-fetch.js";

let server: Server;
let url: string;
beforeAll(async () => {
  server = createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      response.setHeader("Content-Type", "text/plain");
      response.end(`${request.method} ${request.url} ${body}`);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

describe("loopbackFetch", () => {
  it("returns a Response for a loopback request", async () => {
    const response = await loopbackFetch(`${url}/credential`, { method: "POST", body: "{}" });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("POST /credential {}");
  });

  it.each([205, 204, 999])("settles for an unusual status %i instead of crashing", async (code) => {
    const odd = createServer((_request, response) => {
      response.writeHead(code).end();
    });
    await new Promise<void>((resolve) => odd.listen(0, "127.0.0.1", resolve));
    try {
      const target = `http://127.0.0.1:${(odd.address() as AddressInfo).port}/`;
      const settled = await loopbackFetch(target).then(
        (response) => response.status,
        () => "rejected",
      );
      expect(settled === code || settled === "rejected").toBe(true);
    } finally {
      await new Promise<void>((resolve) => odd.close(() => resolve()));
    }
  });

  it("refuses anything but loopback", async () => {
    await expect(loopbackFetch("http://example.com/")).rejects.toThrow("not a loopback URL");
  });

  it("reaches loopback when Node routes fetch through an unreachable env proxy", async () => {
    const module = fileURLToPath(new URL("./loopback-fetch.ts", import.meta.url));
    const script = `
      const { loopbackFetch } = await import(${JSON.stringify(module)});
      const plain = await fetch(${JSON.stringify(url)}).then(() => "reached", () => "proxied");
      const loop = await loopbackFetch(${JSON.stringify(url)}).then((r) => r.text(), (e) => "failed: " + e.message);
      console.log(JSON.stringify({ plain, loop }));
    `;
    // Async: the server answering it lives in this process.
    const { stdout } = await promisify(execFile)(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: {
          PATH: process.env.PATH,
          NODE_USE_ENV_PROXY: "1",
          HTTP_PROXY: "http://127.0.0.1:9",
          NO_PROXY: "",
          NODE_NO_WARNINGS: "1",
        },
        encoding: "utf8",
        timeout: 20_000,
      },
    );
    const result = JSON.parse(stdout.trim().split("\n").at(-1) ?? "{}");
    // The control proves this Node honors the env proxy for fetch at all.
    expect(result.plain).toBe("proxied");
    expect(result.loop).toBe("GET / ");
  });
});
