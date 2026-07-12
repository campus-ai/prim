import { describe, expect, it, vi } from "vitest";
import { kickDaemonEnsure } from "./self-heal.js";

describe("kickDaemonEnsure", () => {
  it("starts daemon ensure as a detached, non-blocking child", () => {
    const unref = vi.fn();
    const spawnProcess = vi.fn(() => ({ unref }));

    expect(
      kickDaemonEnsure({
        primEntry: "/pkg/dist/index.js",
        nodeEntry: "/usr/bin/node",
        spawnProcess,
      }),
    ).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/index.js", "daemon", "ensure"],
      { detached: true, stdio: "ignore" },
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it("fails soft when the CLI entry cannot be resolved", () => {
    const spawnProcess = vi.fn(() => ({ unref: vi.fn() }));
    expect(kickDaemonEnsure({ primEntry: null, spawnProcess })).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("fails soft when the detached child cannot be started", () => {
    const spawnProcess = vi.fn(() => {
      throw new Error("spawn failed");
    });
    expect(kickDaemonEnsure({ primEntry: "/pkg/dist/index.js", spawnProcess })).toBe(false);
  });
});
