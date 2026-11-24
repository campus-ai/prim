import { createHash } from "node:crypto";
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

const API = "https://api.example.com";
const CLIENT = "client_1";
const dirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "prim-retry-"));
  dirs.push(dir);
  return dir;
}
function cooldownPath(directory: string): string {
  const key = createHash("sha256").update(`${API}\0${CLIENT}`).digest("hex");
  return join(directory, `machine_retry_${key}.json`);
}
/** A cooldown with a minute left, so no assertion races the clock. */
function coolDown(directory: string, extra: Record<string, unknown> = {}): void {
  writeFileSync(
    cooldownPath(directory),
    JSON.stringify({ failures: 3, retryAt: Date.now() + 60_000, ...extra }),
  );
}
const attempt = (directory: string, request: () => Promise<unknown>) =>
  withMachineCooldown(directory, API, CLIENT, undefined, request);

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("machine cooldown", () => {
  it("answers from the cooldown without retrying", async () => {
    const directory = tempDir();
    coolDown(directory);
    const request = vi.fn();
    await expect(attempt(directory, request)).rejects.toMatchObject({
      code: "token_service_unavailable",
      message: "Machine authentication is cooling down after a temporary failure. Retry later.",
    });
    expect(request).not.toHaveBeenCalled();
  });

  it("sends a cloud session to the command that retries now and names the cause", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const directory = tempDir();
    coolDown(directory);
    await expect(attempt(directory, vi.fn())).rejects.toMatchObject({
      message:
        "Machine authentication is cooling down after a temporary failure; in this Claude Code cloud session, run `prim setup --cloud` for the fix",
    });
  });

  it("retries at once after prim's own backoff is cleared, leaving other files alone", async () => {
    const directory = tempDir();
    coolDown(directory);
    writeFileSync(join(directory, "machine_profile.json"), "{}");
    writeFileSync(join(directory, "machine_retry_notes.json"), "{}");

    clearMachineCooldowns(directory);

    await expect(attempt(directory, async () => "token")).resolves.toBe("token");
    expect(existsSync(join(directory, "machine_profile.json"))).toBe(true);
    expect(existsSync(join(directory, "machine_retry_notes.json"))).toBe(true);
  });

  it("records a wait the server asked for, and does not clear it", async () => {
    const directory = tempDir();
    const retryAt = Date.now() + 300_000;
    await attempt(directory, () => {
      throw new MachineAuthError("token_service_unavailable", "busy", false, retryAt);
    }).catch(() => undefined);

    clearMachineCooldowns(directory);

    const request = vi.fn();
    await expect(attempt(directory, request)).rejects.toMatchObject({ retryAt });
    expect(request).not.toHaveBeenCalled();
  });

  it("marks only a wait the server asked for, so prim's own backoff is still cleared", async () => {
    const directory = tempDir();
    await attempt(directory, () => {
      throw new MachineAuthError("authentication_unavailable", "unreachable");
    }).catch(() => undefined);
    expect(JSON.parse(readFileSync(cooldownPath(directory), "utf8"))).not.toHaveProperty(
      "serverRetryAfter",
    );

    clearMachineCooldowns(directory);
    await expect(attempt(directory, async () => "token")).resolves.toBe("token");
  });

  it("says a server's wait is a wait, with how long, and points nowhere", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const directory = tempDir();
    coolDown(directory, { serverRetryAfter: true });
    await expect(attempt(directory, vi.fn())).rejects.toMatchObject({
      message: expect.stringMatching(
        /^The sign-in service asked prim to wait; retry in about (59|60)s$/u,
      ),
    });
  });

  it("honours a server's wait only up to fifteen minutes", async () => {
    const directory = tempDir();
    const before = Date.now();
    await attempt(directory, () => {
      throw new MachineAuthError(
        "token_service_unavailable",
        "busy",
        false,
        before + 86_400_000_000,
      );
    }).catch(() => undefined);
    const { retryAt } = JSON.parse(readFileSync(cooldownPath(directory), "utf8"));
    expect(retryAt).toBeGreaterThanOrEqual(before + 15 * 60_000);
    expect(retryAt).toBeLessThanOrEqual(Date.now() + 15 * 60_000);
  });

  const PROXY_FAILING =
    "The cloud environment's proxy is failing (not the Allowed domains list); retry shortly.";
  const state = (directory: string) => JSON.parse(readFileSync(cooldownPath(directory), "utf8"));

  it("names the proxy for as long as a cooldown its failure started lasts", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const directory = tempDir();
    const request = vi.fn(() => {
      throw proxyFault();
    });
    await expect(attempt(directory, request)).rejects.toMatchObject({
      code: "proxy_unavailable",
      message: PROXY_FAILING,
      retryAt: expect.any(Number),
    });
    expect(state(directory)).toEqual({ failures: 1, retryAt: expect.any(Number), proxy: true });

    // The next caller is told the same, with no request made, and is not
    // pointed at a setup step: nothing there repairs a proxy.
    await expect(attempt(directory, request)).rejects.toMatchObject({
      code: "proxy_unavailable",
      message: PROXY_FAILING,
    });
    expect(request).toHaveBeenCalledOnce();
    expect(proxyCooldown(directory, API, CLIENT)).toMatchObject({ message: PROXY_FAILING });
    // Another client, or another deployment, is not held back by it.
    expect(proxyCooldown(directory, API, "client_2")).toBeUndefined();
    expect(proxyCooldown(directory, "https://other.example.com", CLIENT)).toBeUndefined();
  });

  it("keeps the plain cooldown words for a proxy's failure outside a cloud session", async () => {
    const directory = tempDir();
    coolDown(directory, { proxy: true });
    await expect(attempt(directory, vi.fn())).rejects.toMatchObject({
      code: "token_service_unavailable",
      message: "Machine authentication is cooling down after a temporary failure. Retry later.",
    });
    expect(proxyCooldown(directory, API, CLIENT)).toBeUndefined();
  });

  it("starts a cooldown for a broker that gives up, each one longer than the last", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const directory = tempDir();
    expect(proxyCooldown(directory, API, CLIENT)).toBeUndefined();
    const before = Date.now();
    recordProxyFailure(directory, API, CLIENT);
    const first = state(directory);
    expect(first).toEqual({ failures: 1, retryAt: expect.any(Number), proxy: true });
    expect(first.retryAt).toBeGreaterThanOrEqual(before + 1_000);
    expect(first.retryAt).toBeLessThanOrEqual(Date.now() + 2_000);
    recordProxyFailure(directory, API, CLIENT);
    recordProxyFailure(directory, API, CLIENT);
    const third = state(directory);
    expect(third.failures).toBe(3);
    expect(third.retryAt).toBeGreaterThanOrEqual(before + 4_000);

    const request = vi.fn();
    await expect(attempt(directory, request)).rejects.toMatchObject({
      code: "proxy_unavailable",
      retryAt: third.retryAt,
    });
    expect(request).not.toHaveBeenCalled();

    // Once it has run out, the next request is made, and success forgets it.
    vi.spyOn(Date, "now").mockReturnValue(third.retryAt + 1);
    try {
      expect(proxyCooldown(directory, API, CLIENT)).toBeUndefined();
      await expect(attempt(directory, async () => "token")).resolves.toBe("token");
    } finally {
      vi.restoreAllMocks();
    }
    expect(readdirSync(directory)).toEqual([]);
  });

  it("asks a failing proxy again at once on an explicit check, without forgetting it has failed", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const directory = tempDir();
    coolDown(directory, { proxy: true });

    clearMachineCooldowns(directory);

    // The wait is lifted, so the check is made now...
    expect(state(directory)).toEqual({ failures: 3, retryAt: 0, proxy: true });
    expect(proxyCooldown(directory, API, CLIENT)).toBeUndefined();
    const request = vi.fn(() => {
      throw proxyFault();
    });
    const before = Date.now();
    await expect(attempt(directory, request)).rejects.toMatchObject({ message: PROXY_FAILING });
    expect(request).toHaveBeenCalledOnce();
    // ...and a proxy still failing is waited out longer than before, not from
    // one second again: checking in a loop cannot become retrying in a loop.
    const after = state(directory);
    expect(after).toEqual({ failures: 4, retryAt: expect.any(Number), proxy: true });
    expect(after.retryAt).toBeGreaterThanOrEqual(before + 8_000);
    // A proxy that has recovered is forgotten like any other failure.
    clearMachineCooldowns(directory);
    await expect(attempt(directory, async () => "token")).resolves.toBe("token");
    expect(readdirSync(directory)).toEqual([]);
  });

  it("keeps the three kinds of cooldown apart: each is told and cleared its own way", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const told = async (extra: Record<string, unknown>) => {
      const directory = tempDir();
      coolDown(directory, extra);
      const before = await attempt(directory, vi.fn()).catch((error: Error) => error.message);
      clearMachineCooldowns(directory);
      const waiting = existsSync(cooldownPath(directory)) && state(directory).retryAt > Date.now();
      return { before, waiting };
    };
    expect(await told({})).toEqual({
      before:
        "Machine authentication is cooling down after a temporary failure; in this Claude Code cloud session, run `prim setup --cloud` for the fix",
      waiting: false,
    });
    expect(await told({ serverRetryAfter: true })).toEqual({
      before: expect.stringMatching(
        /^The sign-in service asked prim to wait; retry in about \d+s$/u,
      ),
      waiting: true,
    });
    expect(await told({ proxy: true })).toEqual({ before: PROXY_FAILING, waiting: false });
  });

  it("leaves a wait the server asked for standing when a broker gives up on the proxy", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const directory = tempDir();
    coolDown(directory, { serverRetryAfter: true });
    const asked = state(directory).retryAt;

    recordProxyFailure(directory, API, CLIENT);

    expect(state(directory)).toEqual({
      failures: 4,
      retryAt: asked,
      serverRetryAfter: true,
      proxy: true,
    });
    // Not prim's to forget, whatever else is wrong.
    clearMachineCooldowns(directory);
    expect(state(directory).retryAt).toBe(asked);
  });

  it("keeps a cooldown some other failure started to its own words", async () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const directory = tempDir();
    await attempt(directory, () => {
      throw new MachineAuthError("authentication_unavailable", "unreachable");
    }).catch(() => undefined);
    expect(state(directory)).toEqual({ failures: 1, retryAt: expect.any(Number) });
    expect(proxyCooldown(directory, API, CLIENT)).toBeUndefined();
    // Unreadable state stands in nobody's way when a broker must give up.
    writeFileSync(cooldownPath(directory), "not json");
    expect(proxyCooldown(directory, API, CLIENT)).toBeUndefined();
    recordProxyFailure(directory, API, CLIENT);
    expect(state(directory)).toMatchObject({ failures: 1, proxy: true });
  });

  it("clears nothing, and does not throw, where there is no config directory", () => {
    expect(() => clearMachineCooldowns(join(tempDir(), "absent"))).not.toThrow();
  });
});
