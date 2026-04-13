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
    it("returns a client with get/post/patch/delete methods", async () => {
      const { getClient } = await import("./client.js");
      const client = getClient();

      expect(client).toHaveProperty("get");
      expect(client).toHaveProperty("post");
      expect(client).toHaveProperty("patch");
      expect(client).toHaveProperty("delete");
      expect(typeof client.get).toBe("function");
      expect(typeof client.post).toBe("function");
      expect(typeof client.patch).toBe("function");
      expect(typeof client.delete).toBe("function");
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
    it("returns undefined when no refresh token file exists", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const { refreshToken } = await import("./client.js");
      expect(await refreshToken()).toBeUndefined();
    });

    it("returns undefined when refresh token file is empty", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("" as never);
      const { refreshToken } = await import("./client.js");
      expect(await refreshToken()).toBeUndefined();
    });

    it("returns new access token on successful refresh", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("refresh-tok" as never);
      const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
        new Response(
          JSON.stringify({
            access_token: "new-tok",
            refresh_token: "new-refresh",
            expires_in: 3600,
          }),
        ),
      );
      const { refreshToken } = await import("./client.js");
      const result = await refreshToken();
      expect(result).toBe("new-tok");
      expect(fs.writeFileSync).toHaveBeenCalled();
      fetchSpy.mockRestore();
    });

    it("returns undefined on server error without throwing", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("refresh-tok" as never);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(null, { status: 500 }));
      const { refreshToken } = await import("./client.js");
      expect(await refreshToken()).toBeUndefined();
      fetchSpy.mockRestore();
    });

    it("returns undefined on network error without throwing", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(true);
      vi.mocked(fs.readFileSync).mockReturnValue("refresh-tok" as never);
      const fetchSpy = vi
        .spyOn(globalThis, "fetch")
        .mockRejectedValue(new TypeError("fetch failed"));
      const { refreshToken } = await import("./client.js");
      // Should return undefined, NOT throw
      expect(await refreshToken()).toBeUndefined();
      fetchSpy.mockRestore();
    });
  });
});
