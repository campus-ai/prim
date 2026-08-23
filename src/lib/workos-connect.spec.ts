import { describe, expect, it, vi } from "vitest";
import {
  WorkosConnectProtocolError,
  discoverWorkosConnect,
  parseWorkosConnectConfiguration,
  pollWorkosDeviceAuthorization,
  readBoundedJson,
  requestWorkosDeviceAuthorization,
} from "./workos-connect.js";

const configuration = {
  issuer: "https://auth.example.test",
  clientId: "client_cli",
  scopes: ["openid", "profile", "email", "offline_access"],
} as const;

const authorization = {
  deviceCode: "device-secret",
  userCode: "ABCD-EFGH",
  verificationUri: "https://auth.example.test/device",
  verificationUriComplete: "https://auth.example.test/device?user_code=ABCD-EFGH",
  expiresIn: 60,
  interval: 1,
} as const;

function jsonResponse(body: unknown, status = 200, headers?: HeadersInit): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...headers },
  });
}

describe("WorkOS Connect discovery", () => {
  it("accepts only the versioned canonical public tuple", () => {
    expect(
      parseWorkosConnectConfiguration({
        protocol_version: 1,
        issuer: configuration.issuer,
        client_id: configuration.clientId,
        default_scopes: configuration.scopes,
      }),
    ).toEqual(configuration);
  });

  it.each([
    ["wrong version", { protocol_version: 2 }],
    ["credentialed issuer", { issuer: "https://user@auth.example.test" }],
    ["issuer path", { issuer: "https://auth.example.test/path" }],
    ["bad client", { client_id: "application_cli" }],
    ["duplicate scopes", { default_scopes: ["openid", "openid"] }],
    ["reordered scopes", { default_scopes: ["openid", "email", "profile", "offline_access"] }],
    [
      "legacy MCP scope",
      {
        default_scopes: ["openid", "profile", "email", "offline_access", "mcp.tasks.read"],
      },
    ],
  ])("rejects %s", (_name, mutation) => {
    expect(() =>
      parseWorkosConnectConfiguration({
        protocol_version: 1,
        issuer: configuration.issuer,
        client_id: configuration.clientId,
        default_scopes: configuration.scopes,
        ...mutation,
      }),
    ).toThrow(WorkosConnectProtocolError);
  });

  it("falls back only on an explicit old-server 404", async () => {
    const notFound = vi.fn(async () => new Response("not found", { status: 404 }));
    await expect(discoverWorkosConnect("https://api.example.test", notFound)).resolves.toEqual({
      state: "legacy_server",
    });

    const unavailable = vi.fn(async () => jsonResponse({ error: "unavailable" }, 503));
    await expect(discoverWorkosConnect("https://api.example.test", unavailable)).rejects.toThrow(
      "HTTP 503",
    );
  });

  it("rejects a body that exceeds its declared or streamed bound", async () => {
    await expect(
      readBoundedJson(jsonResponse({}, 200, { "Content-Length": "999999" }), 10),
    ).rejects.toThrow("too large");
    await expect(readBoundedJson(new Response('"0123456789"'), 4)).rejects.toThrow("too large");
  });
});

describe("WorkOS Connect device authorization", () => {
  it("posts the public client and scopes to the issuer-derived endpoint", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        device_code: authorization.deviceCode,
        user_code: authorization.userCode,
        verification_uri: authorization.verificationUri,
        verification_uri_complete: authorization.verificationUriComplete,
        expires_in: authorization.expiresIn,
        interval: authorization.interval,
      }),
    );

    await expect(requestWorkosDeviceAuthorization(configuration, fetchImpl)).resolves.toEqual(
      authorization,
    );
    const [url, init] = fetchImpl.mock.calls[0] ?? [];
    expect(url).toBe("https://auth.example.test/oauth2/device_authorization");
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
    });
    expect(String(init?.body)).toBe(
      "client_id=client_cli&scope=openid+profile+email+offline_access",
    );
  });

  it("rejects an off-issuer or oversized verification response", async () => {
    const offIssuer = vi.fn(async () =>
      jsonResponse({
        device_code: authorization.deviceCode,
        user_code: authorization.userCode,
        verification_uri: "https://attacker.test/device",
        expires_in: 60,
        interval: 5,
      }),
    );
    await expect(requestWorkosDeviceAuthorization(configuration, offIssuer)).rejects.toThrow(
      "not trusted",
    );

    const oversized = vi.fn(async () =>
      jsonResponse({
        device_code: "x".repeat(4097),
        user_code: authorization.userCode,
        verification_uri: authorization.verificationUri,
        expires_in: 60,
        interval: 5,
      }),
    );
    await expect(requestWorkosDeviceAuthorization(configuration, oversized)).rejects.toThrow(
      "device_code is invalid",
    );
  });

  it("handles pending and slow-down before accepting one complete token generation", async () => {
    let clock = 0;
    const sleeps: number[] = [];
    const responses = [
      jsonResponse({ error: "authorization_pending" }, 400),
      jsonResponse({ error: "slow_down" }, 400),
      jsonResponse({
        access_token: "access",
        refresh_token: "refresh",
        expires_in: 300,
      }),
    ];
    const fetchImpl = vi.fn(async () => responses.shift() ?? jsonResponse({}, 500));

    await expect(
      pollWorkosDeviceAuthorization(configuration, authorization, {
        fetch: fetchImpl,
        now: () => clock,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
          clock += milliseconds;
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toEqual({ accessToken: "access", refreshToken: "refresh", expiresIn: 300 });
    expect(sleeps).toEqual([1000, 1000, 6000]);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    for (const [url, init] of fetchImpl.mock.calls) {
      expect(url).toBe("https://auth.example.test/oauth2/token");
      expect(String(init?.body)).toContain(
        "grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code",
      );
      expect(String(init?.body)).toContain("client_id=client_cli");
    }
  });

  it.each(["access_denied", "expired_token"])("terminalizes %s", async (error) => {
    let clock = 0;
    const fetchImpl = vi.fn(async () => jsonResponse({ error }, 400));
    await expect(
      pollWorkosDeviceAuthorization(configuration, authorization, {
        fetch: fetchImpl,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        signal: new AbortController().signal,
      }),
    ).rejects.toMatchObject({ code: error });
  });

  it("retries a transient polling transport failure within the fixed deadline", async () => {
    let clock = 0;
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockRejectedValueOnce(new Error("temporary network failure"))
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: "access",
          refresh_token: "refresh",
          expires_in: 300,
        }),
      );

    await expect(
      pollWorkosDeviceAuthorization(configuration, authorization, {
        fetch: fetchImpl,
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
        signal: new AbortController().signal,
      }),
    ).resolves.toMatchObject({ accessToken: "access", refreshToken: "refresh" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("expires without another request when the local deadline is reached", async () => {
    let clock = 0;
    const fetchImpl = vi.fn();
    await expect(
      pollWorkosDeviceAuthorization(
        configuration,
        { ...authorization, expiresIn: 1, interval: 1 },
        {
          fetch: fetchImpl,
          now: () => clock,
          sleep: async (milliseconds) => {
            clock += milliseconds;
          },
          signal: new AbortController().signal,
        },
      ),
    ).rejects.toMatchObject({ code: "expired_token" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
