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
      const result = await refreshToken();

      expect(result).toBeUndefined();
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
  });
});
