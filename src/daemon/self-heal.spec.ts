import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { UNATTENDED_ENV } from "../lib/unattended.js";
import { kickDaemonEnsure } from "./self-heal.js";

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  return child;
}

const detachedUnattended = {
  detached: true,
  stdio: "ignore",
  env: expect.objectContaining({ [UNATTENDED_ENV]: "1" }),
};

describe("kickDaemonEnsure", () => {
  it("starts daemon ensure as a detached, non-blocking, unattended child", () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);

    expect(
      kickDaemonEnsure({
        primEntry: "/pkg/dist/index.js",
        nodeEntry: "/usr/bin/node",
        platform: "darwin",
        spawnProcess,
      }),
    ).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/index.js", "daemon", "ensure", "--latest-bootstrap"],
      detachedUnattended,
    );
    expect(child.unref).toHaveBeenCalledOnce();
  });

  it("leaves non-macOS daemon self-heal behavior unchanged", () => {
    const spawnProcess = vi.fn(() => fakeChild());
    expect(
      kickDaemonEnsure({
        primEntry: "/pkg/dist/index.js",
        nodeEntry: "/usr/bin/node",
        platform: "linux",
        spawnProcess,
      }),
    ).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/index.js", "daemon", "ensure"],
      detachedUnattended,
    );
  });

  it("lets a caller opt out of the macOS registry revalidation", () => {
    const spawnProcess = vi.fn(() => fakeChild());
    expect(
      kickDaemonEnsure({
        primEntry: "/pkg/dist/index.js",
        nodeEntry: "/usr/bin/node",
        platform: "darwin",
        spawnProcess,
        latestBootstrap: false,
      }),
    ).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/index.js", "daemon", "ensure"],
      detachedUnattended,
    );
  });

  it("fails soft when the CLI entry cannot be resolved", () => {
    const spawnProcess = vi.fn(() => fakeChild());
    expect(kickDaemonEnsure({ primEntry: null, spawnProcess })).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("fails soft when the detached child cannot be started", () => {
    const spawnProcess = vi.fn(() => {
      throw new Error("spawn failed");
    });
    expect(kickDaemonEnsure({ primEntry: "/pkg/dist/index.js", spawnProcess })).toBe(false);
  });

  it("absorbs an asynchronous spawn error instead of crashing its caller", () => {
    const child = fakeChild();
    kickDaemonEnsure({ primEntry: "/pkg/dist/index.js", spawnProcess: () => child });

    // An 'error' event with no listener throws from emit(); EAGAIN/EMFILE
    // arrive this way after spawn() has already returned.
    expect(() => child.emit("error", new Error("spawn EAGAIN"))).not.toThrow();
  });
});
