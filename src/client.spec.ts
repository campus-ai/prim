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

  describe("getConvexUrl", () => {
    it("returns VITE_CONVEX_URL from environment", async () => {
      process.env.VITE_CONVEX_URL = "https://test.convex.cloud";
      const { getConvexUrl } = await import("./client.js");
      expect(getConvexUrl()).toBe("https://test.convex.cloud");
    });

    it("throws when no URL is configured", async () => {
      process.env.VITE_CONVEX_URL = undefined;
      const { getConvexUrl } = await import("./client.js");
      expect(() => getConvexUrl()).toThrow("VITE_CONVEX_URL not found");
    });
  });

  describe("getClient", () => {
    it("returns a client with get/post/patch/delete methods", async () => {
      process.env.VITE_CONVEX_URL = "https://test.convex.cloud";
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
});
