import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { fileLockExists, withFileLock } from "./file-lock.js";

describe("withFileLock", () => {
  let scratch: string;
  let lockDir: string;

  beforeEach(() => {
    scratch = mkdtempSync(join(tmpdir(), "prim-file-lock-"));
    lockDir = join(scratch, "nested", "test.lock");
  });

  afterEach(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("recovers a lock whose recorded owner is dead", async () => {
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: 999_999, nonce: "dead", createdAt: Date.now() - 5_000 })}\n`,
    );

    await expect(
      withFileLock(lockDir, () => "acquired", {
        processAlive: () => false,
        pollMs: 1,
      }),
    ).resolves.toBe("acquired");
    expect(fileLockExists(lockDir)).toBe(false);
  });

  it("honors abort while waiting without removing the live owner's lock", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = withFileLock(lockDir, () => held);
    while (!fileLockExists(lockDir)) await new Promise((resolve) => setTimeout(resolve, 1));

    const controller = new AbortController();
    const waiter = withFileLock(lockDir, () => "should-not-run", {
      signal: controller.signal,
      pollMs: 5,
    });
    controller.abort();
    await expect(waiter).rejects.toMatchObject({ name: "AbortError" });
    expect(fileLockExists(lockDir)).toBe(true);

    release();
    await owner;
    expect(fileLockExists(lockDir)).toBe(false);
  });

  it("times out without removing the live owner's lock", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const owner = withFileLock(lockDir, () => held);
    while (!fileLockExists(lockDir)) await new Promise((resolve) => setTimeout(resolve, 1));

    await expect(
      withFileLock(lockDir, () => "should-not-run", {
        timeoutMs: 0,
        processAlive: () => true,
      }),
    ).rejects.toThrow(`timed out waiting for file lock ${lockDir}`);
    expect(fileLockExists(lockDir)).toBe(true);

    release();
    await owner;
    expect(fileLockExists(lockDir)).toBe(false);
  });

  it("writes owner metadata as mode 0600", async () => {
    await withFileLock(lockDir, () => {
      expect(statSync(join(lockDir, "owner.json")).mode & 0o777).toBe(0o600);
    });
  });
});
