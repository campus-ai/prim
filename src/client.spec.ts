import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock fs/os before importing client
vi.mock("node:fs", () => ({
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ""),
  writeFileSync: vi.fn(),
  mkdirSync: vi.fn(),
  renameSync: vi.fn(),
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
    it("returns the production API URL by default", async () => {
      const { getSiteUrl } = await import("./client.js");
      expect(getSiteUrl()).toBe("https://api.getprimitive.ai");
    });

    it("returns PRIM_API_URL when set", async () => {
      process.env.PRIM_API_URL = "https://staging.getprimitive.ai";
      const { getSiteUrl } = await import("./client.js");
      expect(getSiteUrl()).toBe("https://staging.getprimitive.ai");
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
    it("is scoped by environment hostname", async () => {
      const { TOKEN_FILE_PATH } = await import("./client.js");
      expect(TOKEN_FILE_PATH).toContain(".config/prim/environments/api.getprimitive.ai/token");
    });

    it("uses staging hostname when PRIM_API_URL is set", async () => {
      process.env.PRIM_API_URL = "https://staging.getprimitive.ai";
      const { TOKEN_FILE_PATH } = await import("./client.js");
      expect(TOKEN_FILE_PATH).toContain(".config/prim/environments/staging.getprimitive.ai/token");
    });
  });

  describe("REFRESH_TOKEN_PATH", () => {
    it("is sibling to token file in environment directory", async () => {
      const { REFRESH_TOKEN_PATH } = await import("./client.js");
      expect(REFRESH_TOKEN_PATH).toContain(
        ".config/prim/environments/api.getprimitive.ai/refresh_token",
      );
    });
  });

  describe("TOKEN_EXPIRES_PATH", () => {
    it("is sibling to token file in environment directory", async () => {
      const { TOKEN_EXPIRES_PATH } = await import("./client.js");
      expect(TOKEN_EXPIRES_PATH).toContain(
        ".config/prim/environments/api.getprimitive.ai/token_expires_at",
      );
    });
  });

  describe("getTokenExpiresAt", () => {
    it("returns undefined when no expiry file exists", async () => {
      const { getTokenExpiresAt } = await import("./client.js");
      expect(getTokenExpiresAt()).toBeUndefined();
    });
  });
});
