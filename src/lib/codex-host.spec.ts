import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocketServer } from "ws";
import { stableHookCommand } from "./bin-path.js";
import { codexHostGuidance, inspectCodexHost } from "./codex-host.js";

const roots: string[] = [];
const servers: ReturnType<typeof createServer>[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const server of servers.splice(0))
    await new Promise<void>((done) => server.close(() => done()));
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function host(
  options: {
    trust?: string;
    enabled?: boolean;
    loaded?: string[];
    fail?: string;
    stall?: boolean;
  } = {},
) {
  // Keep Unix socket names below macOS's 104-byte limit.
  const root = mkdtempSync("/tmp/prim-codex-");
  roots.push(root);
  vi.stubEnv("CODEX_HOME", root);
  vi.stubEnv("CODEX_THREAD_ID", "calling-session");
  const dir = join(root, "app-server-control");
  mkdirSync(dir);
  const requests: { id: number; method: string; params?: unknown }[] = [];
  const server = createServer();
  servers.push(server);
  const ws = new WebSocketServer({ server });
  ws.on("connection", (socket) => {
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      requests.push(request);
      if (options.stall || request.id === undefined) return;
      if (request.method === options.fail) {
        socket.send(JSON.stringify({ id: request.id, error: { code: -32601 } }));
        return;
      }
      const result =
        request.method === "thread/loaded/list"
          ? { data: options.loaded ?? ["calling-session"] }
          : request.method === "hooks/list"
            ? {
                data: [
                  {
                    cwd: process.cwd(),
                    errors: [],
                    warnings: [],
                    hooks: [
                      {
                        command: `${stableHookCommand("prim-hook")} --agent codex`,
                        enabled: options.enabled ?? true,
                        trustStatus: options.trust ?? "trusted",
                      },
                      { command: "some-other-hook", enabled: false, trustStatus: "untrusted" },
                    ],
                  },
                ],
              }
            : {};
      socket.send(JSON.stringify({ id: request.id, result }));
    });
  });
  await new Promise<void>((done) => server.listen(join(dir, "app-server-control.sock"), done));
  return requests;
}

describe.skipIf(process.platform === "win32")("Codex native hook refresh", () => {
  it("refreshes the loaded caller through an empty native config reload, without changing trust", async () => {
    const requests = await host();
    expect(await inspectCodexHost(true)).toEqual({
      connection: "available",
      trust: "trusted",
      reload: "refreshed",
    });
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "thread/loaded/list",
      "config/batchWrite",
      "hooks/list",
    ]);
    expect(requests.find((request) => request.method === "config/batchWrite")?.params).toEqual({
      edits: [],
      reloadUserConfig: true,
    });
  });

  it("keeps status read-only and distinguishes trust from observed execution", async () => {
    const requests = await host();
    const result = await inspectCodexHost();
    expect(result).toEqual({ connection: "available", trust: "trusted", reload: "not-requested" });
    expect(requests.map((request) => request.method)).toEqual([
      "initialize",
      "initialized",
      "hooks/list",
    ]);
    expect(codexHostGuidance(result)).toContain("Do not ask for trust again");
  });

  it("follows Codex's owned rendezvous symlink to the actual socket", async () => {
    await host();
    const socket = join(
      process.env.CODEX_HOME as string,
      "app-server-control",
      "app-server-control.sock",
    );
    const target = join(process.env.CODEX_HOME as string, "native.sock");
    renameSync(socket, target);
    symlinkSync(target, socket);
    expect((await inspectCodexHost(true)).reload).toBe("refreshed");
  });

  it.each(["untrusted", "modified"])("preserves %s hook trust", async (trust) => {
    await host({ trust });
    const result = await inspectCodexHost(true);
    expect(result.trust).toBe("review-required");
    expect(codexHostGuidance(result)).toContain("review the Primitive hooks");
  });

  it("preserves disabled hooks", async () => {
    await host({ enabled: false });
    expect((await inspectCodexHost(true)).trust).toBe("disabled");
  });

  it("does not reload an unrelated host or write configuration when the caller is absent", async () => {
    const requests = await host({ loaded: ["different-session"] });
    expect(await inspectCodexHost(true)).toMatchObject({
      reload: "unavailable",
      reason: "calling-session-not-loaded",
    });
    expect(requests.some((request) => request.method === "config/batchWrite")).toBe(false);
  });

  it("reports unsupported hosts without claiming reload success", async () => {
    await host({ fail: "config/batchWrite" });
    expect(await inspectCodexHost(true)).toMatchObject({
      reload: "unavailable",
      reason: "host-request-failed",
    });
  });

  it("bounds an unresponsive host", async () => {
    await host({ stall: true });
    expect(await inspectCodexHost(true)).toMatchObject({
      reload: "unavailable",
      reason: "host-timeout",
    });
  });

  it("does not connect to a regular file masquerading as the host socket", async () => {
    const root = mkdtempSync("/tmp/prim-codex-");
    roots.push(root);
    vi.stubEnv("CODEX_HOME", root);
    mkdirSync(join(root, "app-server-control"));
    writeFileSync(join(root, "app-server-control", "app-server-control.sock"), "unrelated");
    expect(await inspectCodexHost(true)).toMatchObject({ reason: "unsafe-host-socket" });
  });
});
