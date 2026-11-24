import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineAuthError } from "./machine-protocol.js";
import { clearMachineCooldowns, withMachineCooldown } from "./machine-retry.js";

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

  it("clears nothing, and does not throw, where there is no config directory", () => {
    expect(() => clearMachineCooldowns(join(tempDir(), "absent"))).not.toThrow();
  });
});
