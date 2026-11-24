import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshClient(cloud: boolean) {
  const dir = mkdtempSync(join(tmpdir(), "prim-client-cloud-"));
  dirs.push(dir);
  vi.stubEnv("PRIM_CONFIG_DIR", dir);
  vi.stubEnv("PRIM_TOKEN", "");
  vi.stubEnv("CLAUDE_CODE_REMOTE", cloud ? "true" : "");
  vi.resetModules();
  return import("./client.js");
}

describe("missing credentials", () => {
  it("names the cloud credential path inside a Claude Code cloud session", async () => {
    const { getPinnedClient } = await freshClient(true);
    await expect(getPinnedClient()).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining("PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET"),
    });
  });

  it("keeps the browser sign-in remedy on a developer machine", async () => {
    const { getPinnedClient } = await freshClient(false);
    await expect(getPinnedClient()).rejects.toMatchObject({
      status: 401,
      message: "Authentication expired. Run `prim auth login` to re-authenticate.",
    });
  });
});
