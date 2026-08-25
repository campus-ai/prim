import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runLatestDaemonBootstrap } from "./latest-bootstrap.js";

const roots: string[] = [];

class FakeChild extends EventEmitter {
  readonly kill = vi.fn(() => true);
}

function root(): string {
  const value = mkdtempSync(join(tmpdir(), "prim-latest-bootstrap-"));
  roots.push(value);
  return value;
}

afterEach(() => {
  for (const value of roots.splice(0)) {
    rmSync(value, { recursive: true, force: true });
  }
});

describe("latest daemon bootstrap", () => {
  it("ensures current first, then revalidates latest with bounded npm retries", async () => {
    const order: string[] = [];
    const child = new FakeChild();
    const spawnProcess = vi.fn((_command, _args, _options) => {
      order.push("latest");
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });

    await expect(
      runLatestDaemonBootstrap(
        async () => {
          order.push("current");
          return { disabled: false };
        },
        {
          env: { PATH: "/usr/bin" },
          lockPath: join(root(), "latest.lock"),
          spawnProcess,
        },
      ),
    ).resolves.toBe(true);

    expect(order).toEqual(["current", "latest"]);
    const [command, args, options] = spawnProcess.mock.calls[0];
    expect(command).toBe("npx");
    expect(args).toEqual([
      "--yes",
      "--prefer-online",
      "-p",
      "@primitive.ai/prim@latest",
      "prim",
      "daemon",
      "ensure",
    ]);
    expect(args).not.toContain("--latest-bootstrap");
    expect(options).toMatchObject({
      stdio: "ignore",
      env: {
        npm_config_prefer_online: "true",
        npm_config_fetch_retries: "1",
        npm_config_fetch_retry_mintimeout: "1000",
        npm_config_fetch_retry_maxtimeout: "5000",
        npm_config_fetch_timeout: "15000",
      },
    });
  });

  it("respects explicit disablement without contacting npm", async () => {
    const spawnProcess = vi.fn();
    await expect(
      runLatestDaemonBootstrap(async () => ({ disabled: true }), {
        lockPath: join(root(), "latest.lock"),
        spawnProcess,
      }),
    ).resolves.toBe(true);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("is single-flight across concurrent SessionStart bootstraps", async () => {
    let releaseCurrent: (() => void) | undefined;
    const currentHeld = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    const child = new FakeChild();
    const spawnProcess = vi.fn(() => {
      queueMicrotask(() => child.emit("exit", 0));
      return child;
    });
    const lockPath = join(root(), "latest.lock");
    const ensureCurrent = vi.fn(async () => {
      await currentHeld;
      return { disabled: false };
    });

    const first = runLatestDaemonBootstrap(ensureCurrent, { lockPath, spawnProcess });
    await vi.waitFor(() => expect(ensureCurrent).toHaveBeenCalledOnce());
    await expect(runLatestDaemonBootstrap(ensureCurrent, { lockPath, spawnProcess })).resolves.toBe(
      false,
    );
    releaseCurrent?.();
    await expect(first).resolves.toBe(true);
    expect(ensureCurrent).toHaveBeenCalledOnce();
    expect(spawnProcess).toHaveBeenCalledOnce();
  });

  it("keeps current-ensure and npm failures soft", async () => {
    await expect(
      runLatestDaemonBootstrap(
        async () => {
          throw new Error("ensure failed");
        },
        { lockPath: join(root(), "ensure.lock") },
      ),
    ).resolves.toBe(false);
    await expect(
      runLatestDaemonBootstrap(async () => ({ disabled: false }), {
        lockPath: join(root(), "spawn.lock"),
        spawnProcess: () => {
          throw new Error("spawn failed");
        },
      }),
    ).resolves.toBe(false);
  });

  it("terminates a wedged npm lookup at the hard deadline", async () => {
    const child = new FakeChild();
    await expect(
      runLatestDaemonBootstrap(async () => ({ disabled: false }), {
        lockPath: join(root(), "timeout.lock"),
        spawnProcess: () => child,
        timeoutMs: 5,
      }),
    ).resolves.toBe(false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });
});
