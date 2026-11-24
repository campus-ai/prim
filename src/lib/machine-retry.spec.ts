import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineAuthError, proxyFault } from "./machine-protocol.js";
import {
  clearMachineCooldowns,
  proxyCooldown,
  recordProxyFailure,
  withMachineCooldown,
} from "./machine-retry.js";

const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prim-retry-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function failOnce(directory: string): Promise<void> {
  await withMachineCooldown(directory, "https://api.example.com", "client_1", undefined, () => {
    throw new MachineAuthError("authentication_unavailable", "unreachable");
  }).catch(() => undefined);
}

describe("machine cooldown", () => {
  it("answers from the cooldown without retrying, and says where a cloud session finds the cause", async () => {
    const directory = tempDir();
    await failOnce(directory);
    const request = vi.fn();

    await expect(
      withMachineCooldown(directory, "https://api.example.com", "client_1", undefined, request),
    ).rejects.toMatchObject({
      code: "token_service_unavailable",
      message: "Machine authentication is cooling down after a temporary failure. Retry later.",
    });

    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    await expect(
      withMachineCooldown(directory, "https://api.example.com", "client_1", undefined, request),
    ).rejects.toMatchObject({
      message: expect.stringContaining("run `prim setup --cloud` for the fix"),
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("retries at once after the cooldowns are cleared, leaving other files alone", async () => {
    const directory = tempDir();
    await failOnce(directory);
    writeFileSync(join(directory, "machine_profile.json"), "{}");
    writeFileSync(join(directory, "machine_retry_notes.json"), "{}");

    clearMachineCooldowns(directory);

    const request = vi.fn(async () => "token");
    await expect(
      withMachineCooldown(directory, "https://api.example.com", "client_1", undefined, request),
    ).resolves.toBe("token");
    expect(existsSync(join(directory, "machine_profile.json"))).toBe(true);
    expect(existsSync(join(directory, "machine_retry_notes.json"))).toBe(true);
  });

  const API = "https://api.example.com";
  const PROXY_FAILING =
    "The cloud environment's proxy is failing (not the Allowed domains list); retry shortly.";
  const state = (directory: string) => {
    const [name] = readdirSync(directory).filter((file) => file.startsWith("machine_retry_"));
    return JSON.parse(readFileSync(join(directory, name ?? ""), "utf8"));
  };

  it("names the proxy for as long as a cooldown its failure started lasts", async () => {
    const directory = tempDir();
    const request = vi.fn(() => {
      throw proxyFault();
    });
    await expect(
      withMachineCooldown(directory, API, "client_1", undefined, request),
    ).rejects.toMatchObject({ code: "proxy_unavailable", retryAt: expect.any(Number) });
    expect(state(directory)).toMatchObject({ failures: 1, proxy: true });

    // The next caller is told the same, with no request made, and not sent
    // to a setup step that cannot repair a proxy.
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    await expect(
      withMachineCooldown(directory, API, "client_1", undefined, request),
    ).rejects.toMatchObject({ code: "proxy_unavailable", message: PROXY_FAILING });
    expect(request).toHaveBeenCalledOnce();
    expect(proxyCooldown(directory, API, "client_1")).toMatchObject({ message: PROXY_FAILING });
    // Another client, or another deployment, is not held back by it.
    expect(proxyCooldown(directory, API, "client_2")).toBeUndefined();
    expect(proxyCooldown(directory, "https://other.example.com", "client_1")).toBeUndefined();
  });

  it("starts a cooldown for a broker that gives up, each one longer than the last", async () => {
    const directory = tempDir();
    expect(proxyCooldown(directory, API, "client_1")).toBeUndefined();
    const before = Date.now();
    recordProxyFailure(directory, API, "client_1");
    const first = state(directory);
    expect(first).toMatchObject({ failures: 1, proxy: true });
    expect(first.retryAt).toBeGreaterThanOrEqual(before + 1_000);
    expect(first.retryAt).toBeLessThanOrEqual(Date.now() + 2_000);
    recordProxyFailure(directory, API, "client_1");
    recordProxyFailure(directory, API, "client_1");
    const third = state(directory);
    expect(third.failures).toBe(3);
    expect(third.retryAt).toBeGreaterThanOrEqual(before + 4_000);

    const request = vi.fn();
    await expect(
      withMachineCooldown(directory, API, "client_1", undefined, request),
    ).rejects.toMatchObject({ code: "proxy_unavailable", retryAt: third.retryAt });
    expect(request).not.toHaveBeenCalled();

    // Once it has run out, the next request is made, and success forgets it.
    vi.spyOn(Date, "now").mockReturnValue(third.retryAt + 1);
    try {
      expect(proxyCooldown(directory, API, "client_1")).toBeUndefined();
      await expect(
        withMachineCooldown(directory, API, "client_1", undefined, async () => "token"),
      ).resolves.toBe("token");
    } finally {
      vi.restoreAllMocks();
    }
    expect(readdirSync(directory)).toEqual([]);
  });

  it("keeps a cooldown some other failure started to its own words", async () => {
    const directory = tempDir();
    await failOnce(directory);
    expect(state(directory)).toEqual({ failures: 1, retryAt: expect.any(Number) });
    expect(proxyCooldown(directory, API, "client_1")).toBeUndefined();
    // Unreadable state stands in nobody's way when a broker must give up.
    writeFileSync(join(directory, readdirSync(directory)[0] ?? ""), "not json");
    expect(proxyCooldown(directory, API, "client_1")).toBeUndefined();
    recordProxyFailure(directory, API, "client_1");
    expect(state(directory)).toMatchObject({ failures: 1, proxy: true });
  });

  it("clears nothing, and does not throw, where there is no config directory", () => {
    expect(() => clearMachineCooldowns(join(tempDir(), "absent"))).not.toThrow();
  });
});
