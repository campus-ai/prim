import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DAEMON_STARTUP_GRACE_MS,
  acquireDaemonOwnership,
  releaseDaemonOwnership,
} from "./instance-lock.js";

describe("daemon instance ownership", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-daemon-lock-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps the compatibility pidfile numeric and excludes a live owner", () => {
    const first = acquireDaemonOwnership(dir, { pid: 42, isAlive: () => false });
    expect(readFileSync(join(dir, "daemon.pid"), "utf-8")).toBe("42");

    expect(() => acquireDaemonOwnership(dir, { pid: 43, isAlive: (pid) => pid === 42 })).toThrow(
      "daemon already running (pid=42)",
    );
    expect(releaseDaemonOwnership(first)).toBe(true);
  });

  it("never replaces an old nonce owner while its pid remains live", () => {
    const first = acquireDaemonOwnership(dir, { pid: 42, now: 1, isAlive: () => false });

    expect(() =>
      acquireDaemonOwnership(dir, {
        pid: 43,
        now: 60_000,
        isAlive: (pid) => pid === 42,
      }),
    ).toThrow("daemon already running (pid=42)");
    expect(releaseDaemonOwnership(first)).toBe(true);
  });

  it("conservatively preserves a live legacy pid even without a nonce lock", () => {
    writeFileSync(join(dir, "daemon.pid"), "42");

    expect(() => acquireDaemonOwnership(dir, { pid: 43, isAlive: (pid) => pid === 42 })).toThrow(
      "daemon already running (pid=42)",
    );
    expect(readFileSync(join(dir, "daemon.pid"), "utf-8")).toBe("42");
  });

  it.each([0, Number.MAX_SAFE_INTEGER + 1])(
    "applies startup grace before replacing an invalid owner pid %s",
    (pid) => {
      const lockDir = join(dir, "daemon.lock");
      mkdirSync(lockDir);
      writeFileSync(
        join(lockDir, "owner.json"),
        JSON.stringify({ pid, instanceId: "invalid", startedAt: Date.now() }),
      );
      const mtimeMs = statSync(lockDir).mtimeMs;

      expect(() =>
        acquireDaemonOwnership(dir, {
          pid: 43,
          now: mtimeMs + DAEMON_STARTUP_GRACE_MS - 1,
          isAlive: () => false,
        }),
      ).toThrow("daemon startup already in progress");

      const owner = acquireDaemonOwnership(dir, {
        pid: 43,
        now: mtimeMs + DAEMON_STARTUP_GRACE_MS,
        isAlive: () => false,
      });
      expect(readFileSync(join(dir, "daemon.pid"), "utf-8")).toBe("43");
      expect(releaseDaemonOwnership(owner)).toBe(true);
    },
  );

  it("atomically replaces a dead owner's lock", () => {
    acquireDaemonOwnership(dir, { pid: 42, isAlive: () => false });
    const replacement = acquireDaemonOwnership(dir, { pid: 43, isAlive: () => false });

    expect(readFileSync(join(dir, "daemon.pid"), "utf-8")).toBe("43");
    expect(releaseDaemonOwnership(replacement)).toBe(true);
  });

  it("never removes artifacts after losing its ownership nonce", () => {
    const owner = acquireDaemonOwnership(dir, { pid: 42, isAlive: () => false });
    const socket = join(dir, "sock");
    writeFileSync(socket, "socket placeholder");
    writeFileSync(
      owner.ownerPath,
      JSON.stringify({ pid: 99, instanceId: "replacement", startedAt: Date.now() }),
    );

    expect(releaseDaemonOwnership(owner, socket)).toBe(false);
    expect(existsSync(socket)).toBe(true);
    expect(existsSync(join(dir, "daemon.pid"))).toBe(true);
  });
});
