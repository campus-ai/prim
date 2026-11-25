import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import type { Duplex } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  discoverMachineConfiguration,
  rejectedCredentialsMessage,
  verifyMachineIdentity,
} from "./machine-protocol.js";
import { tunnelCheckedFetch } from "./proxy-tunnel.js";

afterEach(() => vi.unstubAllEnvs());

const unreachable = (async () => {
  throw new TypeError("fetch failed");
}) as unknown as typeof fetch;

describe("machine authentication guidance in Claude Code cloud sessions", () => {
  it("names the host a cloud environment may be blocking", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    await expect(
      discoverMachineConfiguration("https://api.example.com", undefined, unreachable),
    ).rejects.toMatchObject({
      code: "authentication_unavailable",
      message:
        "Machine authentication could not reach api.example.com. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains (Network access: Limited).",
    });
  });

  it("says the allowlist edit reaches the session where its requests ride the proxy", async () => {
    // As in the token broker of a cloud session with credentials in its variables.
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("HTTPS_PROXY", "http://127.0.0.1:3128");
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
    const failure = await discoverMachineConfiguration(
      "https://api.example.com",
      undefined,
      unreachable,
    ).catch((error: unknown) => error as Error);
    expect(failure.message).toBe(
      "Machine authentication could not reach api.example.com. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains (Network access: Limited); the change takes effect in this session within about a minute.",
    );
    expect(failure.message).not.toMatch(/new (cloud )?session/u);
  });

  /** Discovery through a stand-in proxy that answers every CONNECT with `answer`. */
  async function discoverThroughProxy(answer: number | "close" | "silent"): Promise<Error> {
    const proxy = createServer();
    const held: Duplex[] = [];
    proxy.on("connect", (_request, socket: Duplex) => {
      if (answer === "close") socket.destroy();
      else if (answer === "silent") held.push(socket);
      else socket.end(`HTTP/1.1 ${answer} Answer\r\nContent-Length: 0\r\n\r\n`);
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    try {
      return await discoverMachineConfiguration(
        "https://api.example.com",
        undefined,
        tunnelCheckedFetch({
          env: {
            NODE_USE_ENV_PROXY: "1",
            HTTPS_PROXY: `http://127.0.0.1:${(proxy.address() as AddressInfo).port}`,
          },
          fetch: unreachable,
          // Silence is waited out; an answer is given time to arrive.
          timeoutMs: answer === "silent" ? 150 : 2_000,
        }),
      ).catch((error: unknown) => error as Error);
    } finally {
      for (const socket of held) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  }

  it.each([502, 503, 407, "close"] as const)(
    "blames the proxy, not the allowlist, when it answers a CONNECT with %s",
    async (answer) => {
      vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
      expect(await discoverThroughProxy(answer)).toMatchObject({
        code: "proxy_unavailable",
        terminal: false,
        message:
          "The cloud environment's proxy is failing (not the Allowed domains list); retry shortly.",
      });
    },
  );

  it("says of a proxy that does not answer only that, and starts no cooldown in the proxy's name", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const silent = await discoverThroughProxy("silent");
    // Not the proxy's fault for certain, and not the allowlist's either.
    expect(silent).toMatchObject({
      code: "authentication_unavailable",
      terminal: false,
      message: "The cloud environment's proxy did not answer in time; retry shortly.",
    });
    expect(silent.message).not.toContain("Allowed domains");
  });

  it("keeps the allowlist advice for a host the proxy refuses", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    expect(await discoverThroughProxy(403)).toMatchObject({
      code: "authentication_unavailable",
      message: expect.stringContaining(
        "could not reach api.example.com. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains",
      ),
    });
  });

  it("says nothing of a cloud environment's proxy on a developer machine", async () => {
    expect(await discoverThroughProxy(502)).toMatchObject({
      code: "authentication_unavailable",
      message: "Machine authentication is temporarily unavailable. Check the connection and retry.",
    });
  });

  it("keeps the connection advice on a developer machine", async () => {
    await expect(
      discoverMachineConfiguration("https://api.example.com", undefined, unreachable),
    ).rejects.toMatchObject({
      message: "Machine authentication is temporarily unavailable. Check the connection and retry.",
    });
  });

  it("says the same when the API, not the token service, rejects the machine", async () => {
    const forbidden = (async () => new Response("{}", { status: 403 })) as unknown as typeof fetch;
    const verify = () =>
      verifyMachineIdentity("https://api.example.com", "token", "client_1", undefined, forbidden);
    await expect(verify()).rejects.toMatchObject({
      message: expect.stringContaining("Ask your administrator"),
    });
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    await expect(verify()).rejects.toMatchObject({
      code: "machine_access_rejected",
      message: expect.stringContaining("The cloud environment's credentials were rejected"),
    });
  });

  it("sends a cloud session's owner to the environment, not to an administrator", () => {
    const local =
      "Machine credentials were rejected. Ask your administrator to rotate or enable them.";
    expect(rejectedCredentialsMessage(local, {})).toBe(local);
    const cloud = rejectedCredentialsMessage(local, { CLAUDE_CODE_REMOTE: "true" });
    expect(cloud).toContain("The cloud environment's credentials were rejected");
    expect(cloud).toContain("prim auth enroll --new-installation");
    expect(cloud).toContain("then start a new cloud session");
    expect(cloud).not.toContain("administrator");
  });
});
