import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineAuthError } from "./machine-protocol.js";
import { clearMachineCooldowns, withMachineCooldown } from "./machine-retry.js";

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

  it("clears nothing, and does not throw, where there is no config directory", () => {
    expect(() => clearMachineCooldowns(join(tempDir(), "absent"))).not.toThrow();
  });
});
