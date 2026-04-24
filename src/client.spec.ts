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

  beforeEach(async () => {
    vi.resetModules();
    process.env = { ...originalEnv };
    // Reset mock implementations to defaults so they don't leak between tests
    const fs = await import("node:fs");
    vi.mocked(fs.existsSync).mockReturnValue(false);
    vi.mocked(fs.readFileSync).mockReturnValue("");
    vi.mocked(fs.writeFileSync).mockReset();
    vi.mocked(fs.mkdirSync).mockReset();
    vi.mocked(fs.renameSync).mockReset();
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

  describe("migrateTokensIfNeeded", () => {
    it("migrates legacy flat token files to the prod environment directory", async () => {
      const fs = await import("node:fs");
      const existsSyncMock = vi.mocked(fs.existsSync);
      const mkdirSyncMock = vi.mocked(fs.mkdirSync);
      const renameSyncMock = vi.mocked(fs.renameSync);

      // Simulate legacy files existing, no new-location files
      existsSyncMock.mockImplementation((p) => {
        const path = String(p);
        if (path.includes("environments/")) return false;
        if (path.endsWith(".config/prim/token")) return true;
        if (path.endsWith(".config/prim/refresh_token")) return true;
        if (path.endsWith(".config/prim/token_expires_at")) return true;
        return false;
      });

      // Module-level migrateTokensIfNeeded() runs on import
      await import("./client.js");

      expect(mkdirSyncMock).toHaveBeenCalledWith(
        expect.stringContaining("environments/api.getprimitive.ai"),
        { recursive: true },
      );
      expect(renameSyncMock).toHaveBeenCalledTimes(3);
      expect(renameSyncMock).toHaveBeenCalledWith(
        expect.stringContaining(".config/prim/token"),
        expect.stringContaining("environments/api.getprimitive.ai/token"),
      );
    });

    it("skips migration when no legacy files exist", async () => {
      const fs = await import("node:fs");
      vi.mocked(fs.existsSync).mockReturnValue(false);
      const renameSyncMock = vi.mocked(fs.renameSync);

      await import("./client.js");

      expect(renameSyncMock).not.toHaveBeenCalled();
    });

    it("skips individual files that already exist at destination", async () => {
      const fs = await import("node:fs");
      const existsSyncMock = vi.mocked(fs.existsSync);
      const renameSyncMock = vi.mocked(fs.renameSync);

      // Legacy token exists, but destination token already exists (partial prior migration)
      existsSyncMock.mockImplementation((p) => {
        const path = String(p);
        if (path.endsWith("environments/api.getprimitive.ai/token")) return true;
        if (path.endsWith(".config/prim/token")) return true;
        return false;
      });

      await import("./client.js");

      // Should not rename token since destination exists; no other legacy files to migrate
      expect(renameSyncMock).not.toHaveBeenCalled();
    });
  });
});
