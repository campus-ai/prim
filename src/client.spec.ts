import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs/os before importing client
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
}));
vi.mock("node:os", () => ({
  homedir: vi.fn(() => "/home/test"),
}));

describe("client", () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe("getAuthToken", () => {
    it("returns PRIM_TOKEN from environment", async () => {
      process.env.PRIM_TOKEN = "env-token-123";
      const { getAuthToken } = await import("./client.js");
      expect(getAuthToken()).toBe("env-token-123");
    });

    it("returns undefined when no token source is available", async () => {
      process.env.PRIM_TOKEN = undefined;
      const { getAuthToken } = await import("./client.js");
      expect(getAuthToken()).toBeUndefined();
    });
  });

  describe("getSiteUrl", () => {
    it("returns the production API URL", async () => {
      const { getSiteUrl } = await import("./client.js");
      expect(getSiteUrl()).toBe("https://api.getprimitive.ai");
    });
  });

  describe("getClient", () => {
    it("returns a client with get/post methods", async () => {
      const { getClient } = await import("./client.js");
      const client = getClient();

      expect(client).toHaveProperty("get");
      expect(client).toHaveProperty("post");
      expect(typeof client.get).toBe("function");
      expect(typeof client.post).toBe("function");
    });

    it("uses one caller signal for proactive refresh, request, 401 refresh, and retry", async () => {
      process.env.PRIM_TOKEN = "initial-token";
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockImplementation((path) => {
        const value = String(path);
        return value.endsWith("token_expires_at") || value.endsWith("refresh_token");
      });
      vi.mocked(fs.readFileSync).mockImplementation((path) =>
        String(path).endsWith("token_expires_at") ? "0" : "refresh-token",
      );
      let refreshes = 0;
      let requests = 0;
      const signal = new AbortController().signal;
      const fetchMock = vi.fn((url: string | URL | Request, init?: RequestInit) => {
        expect(init?.signal).toBe(signal);
        if (String(url).includes("/mcp/broker/refresh")) {
          refreshes += 1;
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () => Promise.resolve({ access_token: `refreshed-${String(refreshes)}` }),
          });
        }
        requests += 1;
        return Promise.resolve(
          requests === 1
            ? { ok: false, status: 401 }
            : { ok: true, status: 200, json: () => Promise.resolve({ ok: true }) },
        );
      });
      vi.stubGlobal("fetch", fetchMock);

      const { getClient } = await import("./client.js");
      await expect(
        getClient().post("/api/cli/test", {}, { signal, quietRefresh: true }),
      ).resolves.toEqual({ ok: true });
      expect(refreshes).toBe(2);
      expect(requests).toBe(2);
      expect(fetchMock).toHaveBeenCalledTimes(4);

      vi.unstubAllGlobals();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue("");
    });
  });

  describe("TOKEN_FILE_PATH", () => {
    it("is in ~/.config/prim/", async () => {
      const { TOKEN_FILE_PATH } = await import("./client.js");
      expect(TOKEN_FILE_PATH).toContain(".config/prim/token");
    });
  });

  describe("REFRESH_TOKEN_PATH", () => {
    it("is sibling to token file", async () => {
      const { REFRESH_TOKEN_PATH } = await import("./client.js");
      expect(REFRESH_TOKEN_PATH).toContain(".config/prim/refresh_token");
    });
  });

  describe("TOKEN_EXPIRES_PATH", () => {
    it("is sibling to token file", async () => {
      const { TOKEN_EXPIRES_PATH } = await import("./client.js");
      expect(TOKEN_EXPIRES_PATH).toContain(".config/prim/token_expires_at");
    });
  });

  describe("getTokenExpiresAt", () => {
    it("returns undefined when no expiry file exists", async () => {
      const { getTokenExpiresAt } = await import("./client.js");
      expect(getTokenExpiresAt()).toBeUndefined();
    });
  });

  describe("refreshToken", () => {
    it("surfaces the broker rejection reason instead of failing silently", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("rt-value");
      const fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: () => Promise.resolve("invalid_grant"),
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);

      const { refreshToken } = await import("./client.js");
      const signal = AbortSignal.timeout(10_000);
      const result = await refreshToken({ signal });

      expect(result).toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        "https://api.getprimitive.ai/mcp/broker/refresh",
        expect.objectContaining({ signal }),
      );
      const msg = stderr.mock.calls.map((c) => String(c[0])).join("");
      expect(msg).toContain("401");
      expect(msg).toContain("invalid_grant");
      // The diagnostic must never leak the refresh token itself.
      expect(msg).not.toContain("rt-value");

      stderr.mockRestore();
      vi.unstubAllGlobals();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue("");
    });
    it("propagates the shared abort signal and can suppress hook diagnostics", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("rt-value");
      const fetchMock = vi.fn(() =>
        Promise.resolve({
          ok: false,
          status: 401,
          statusText: "Unauthorized",
          text: () => Promise.resolve("invalid_grant"),
        }),
      );
      vi.stubGlobal("fetch", fetchMock);
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const controller = new AbortController();

      const { refreshToken } = await import("./client.js");
      await expect(
        refreshToken({ signal: controller.signal, quiet: true }),
      ).resolves.toBeUndefined();
      expect(fetchMock).toHaveBeenCalledWith(
        expect.stringContaining("/mcp/broker/refresh"),
        expect.objectContaining({ signal: controller.signal }),
      );
      expect(stderr).not.toHaveBeenCalled();

      stderr.mockRestore();
      vi.unstubAllGlobals();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue("");
    });
    it("single-flights concurrent rotations and updates the request cache", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("rt-value");
      let finishRefresh: ((value: unknown) => void) | undefined;
      const refreshResponse = new Promise((resolve) => {
        finishRefresh = resolve;
      });
      const fetchMock = vi
        .fn()
        .mockImplementationOnce(() => refreshResponse)
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true }),
        });
      vi.stubGlobal("fetch", fetchMock);

      const { getClient, refreshToken } = await import("./client.js");
      const first = refreshToken();
      const second = refreshToken();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      finishRefresh?.({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ access_token: "new-access", refresh_token: "new-refresh" }),
      });
      await expect(Promise.all([first, second])).resolves.toEqual(["new-access", "new-access"]);

      await getClient().get("/api/cli/test");
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: "Bearer new-access" }),
      });

      vi.unstubAllGlobals();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue("");
    });

    it("reuses a refresh that completed while an old-token request was in flight", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("rt-value");
      process.env.PRIM_TOKEN = "old-access";

      let rejectOldRequest: ((value: unknown) => void) | undefined;
      const oldRequest = new Promise((resolve) => {
        rejectOldRequest = resolve;
      });
      const fetchMock = vi.fn((url: string) => {
        if (url.endsWith("/mcp/broker/refresh")) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: () =>
              Promise.resolve({ access_token: "new-access", refresh_token: "new-refresh" }),
          });
        }
        if (fetchMock.mock.calls.filter(([calledUrl]) => calledUrl === url).length === 1) {
          return oldRequest;
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: () => Promise.resolve({ ok: true }),
        });
      });
      vi.stubGlobal("fetch", fetchMock);

      const { getClient, refreshToken } = await import("./client.js");
      const request = getClient().get("/api/cli/test");
      await refreshToken();
      rejectOldRequest?.({ ok: false, status: 401 });
      await expect(request).resolves.toEqual({ ok: true });

      expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/refresh"))).toHaveLength(
        1,
      );
      expect(fetchMock.mock.calls.at(-1)?.[1]).toMatchObject({
        headers: expect.objectContaining({ Authorization: "Bearer new-access" }),
      });

      vi.unstubAllGlobals();
      vi.mocked(fs.existsSync).mockReturnValue(false);
      vi.mocked(fs.readFileSync).mockReturnValue("");
    });
  });
});
