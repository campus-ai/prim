import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { type Server, createServer } from "node:http";
import type { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "tsup";
import { describe, expect, it, vi } from "vitest";
import {
  type DaemonHealthState,
  createDaemonHealthState,
  writeDaemonHealthState,
} from "../daemon/health.js";
import { flush } from "../flusher.js";
import { daemonOwnsDrain, startBackgroundFlush } from "./background-flush.js";
import { processIsAlive } from "./process-liveness.js";

vi.mock("../flusher.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../flusher.js")>()),
  flush: vi.fn(),
}));

// Unit cases must not read this machine's real daemon health.
const noDaemon = () => false;

function fakeChild() {
  const child = new EventEmitter() as EventEmitter & { unref: ReturnType<typeof vi.fn> };
  child.unref = vi.fn();
  return child;
}

describe("startBackgroundFlush", () => {
  it("hands an overdue journal to a detached, unref'd moves flush with ignored stdio", () => {
    const child = fakeChild();
    const spawnProcess = vi.fn(() => child);

    expect(
      startBackgroundFlush({
        needsFlush: () => true,
        daemonOwnsDrain: noDaemon,
        primEntry: "/pkg/dist/index.js",
        nodeEntry: "/usr/bin/node",
        spawnProcess,
      }),
    ).toBe(true);
    expect(spawnProcess).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/pkg/dist/index.js", "moves", "flush"],
      { detached: true, stdio: "ignore", windowsHide: true },
    );
    expect(child.unref).toHaveBeenCalledOnce();
    // The invoking process never drains in-process, so it holds no lock,
    // socket, or timer that could keep it alive.
    expect(flush).not.toHaveBeenCalled();
  });

  it("starts nothing when the journal has no overdue Moves", () => {
    const spawnProcess = vi.fn(() => fakeChild());

    expect(
      startBackgroundFlush({
        needsFlush: () => false,
        daemonOwnsDrain: noDaemon,
        primEntry: "/pkg/i.js",
        spawnProcess,
      }),
    ).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
  });

  it("fails soft when the journal check, the entry, or the spawn is unavailable", () => {
    const spawnProcess = vi.fn(() => fakeChild());
    expect(
      startBackgroundFlush({
        needsFlush: () => {
          throw new Error("scan failed");
        },
        daemonOwnsDrain: noDaemon,
        primEntry: "/pkg/i.js",
        spawnProcess,
      }),
    ).toBe(false);
    expect(
      startBackgroundFlush({
        needsFlush: () => true,
        daemonOwnsDrain: noDaemon,
        primEntry: null,
        spawnProcess,
      }),
    ).toBe(false);
    expect(spawnProcess).not.toHaveBeenCalled();
    expect(
      startBackgroundFlush({
        needsFlush: () => true,
        daemonOwnsDrain: noDaemon,
        primEntry: "/pkg/i.js",
        spawnProcess: () => {
          throw new Error("spawn failed");
        },
      }),
    ).toBe(false);
  });

  it("absorbs an asynchronous spawn error instead of crashing the command", () => {
    const child = fakeChild();
    startBackgroundFlush({
      needsFlush: () => true,
      daemonOwnsDrain: noDaemon,
      primEntry: "/pkg/i.js",
      spawnProcess: () => child,
    });

    // An 'error' event with no listener throws from emit(); EAGAIN/EMFILE
    // arrive this way after spawn() has already returned.
    expect(() => child.emit("error", new Error("spawn EAGAIN"))).not.toThrow();
  });

  it("starts nothing, and skips the journal scan, while a healthy daemon owns the drain", () => {
    const needsFlush = vi.fn(() => true);
    const spawnProcess = vi.fn(() => fakeChild());

    expect(
      startBackgroundFlush({
        needsFlush,
        daemonOwnsDrain: () => true,
        primEntry: "/pkg/i.js",
        spawnProcess,
      }),
    ).toBe(false);
    expect(needsFlush).not.toHaveBeenCalled();
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});

describe("daemonOwnsDrain", () => {
  const NOW = 1_800_000_000_000;
  const VERSION = "1.2.3";
  const DAEMON_PID = 4242;
  const SITE_URL = "https://api.example.test";

  // The exact file the daemon persists, built and written by its own code.
  function withHealth(
    mutate: (state: DaemonHealthState) => void,
    check: (healthPath: string) => void,
  ): void {
    const root = mkdtempSync(join(tmpdir(), "prim-daemon-owner-"));
    try {
      const state = createDaemonHealthState(VERSION, DAEMON_PID, NOW - 60_000, SITE_URL);
      state.heartbeat.lastSuccessAt = NOW - 5_000;
      state.ingestion.healthy = false;
      state.ingestion.pendingCount = 1200;
      state.ingestion.oldestPendingAt = NOW - 2 * 86_400_000;
      mutate(state);
      const healthPath = join(root, "daemon-health.json");
      writeDaemonHealthState(state, healthPath);
      check(healthPath);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  const owns = (healthPath: string, overrides: Parameters<typeof daemonOwnsDrain>[0] = {}) =>
    daemonOwnsDrain({
      healthPath,
      now: NOW,
      expectedVersion: VERSION,
      siteUrl: SITE_URL,
      isAlive: (pid) => pid === DAEMON_PID,
      ...overrides,
    });

  it("is true for a live, current, heartbeating daemon with no ingestion failure", () => {
    // Behind its SLA is fine: that daemon is the drainer a child would race.
    withHealth(
      () => undefined,
      (path) => expect(owns(path)).toBe(true),
    );
  });

  it.each<[string, (state: DaemonHealthState) => void]>([
    [
      "a recorded ingestion failure",
      (state) => {
        state.ingestion.consecutiveFailures = 1;
      },
    ],
    [
      "a failing heartbeat",
      (state) => {
        state.heartbeat.consecutiveFailures = 2;
      },
    ],
    [
      "a heartbeat that never succeeded",
      (state) => {
        state.heartbeat.lastSuccessAt = undefined;
      },
    ],
    [
      "a stale heartbeat",
      (state) => {
        state.heartbeat.lastSuccessAt = NOW - 91_000;
      },
    ],
    [
      // A clock stepped backwards makes an old heartbeat look recent.
      "a heartbeat stamped after now",
      (state) => {
        state.heartbeat.lastSuccessAt = NOW + 1_000;
      },
    ],
    [
      // Its journal partition is another deployment's, not this CLI's.
      "a daemon delivering to another deployment",
      (state) => {
        state.siteUrl = "https://staging.example.test";
      },
    ],
    [
      "a daemon that predates the recorded deployment",
      (state) => {
        state.siteUrl = undefined;
      },
    ],
    [
      "a re-auth hold",
      (state) => {
        state.needsReauth = true;
      },
    ],
    [
      "another version",
      (state) => {
        state.version = "1.2.2";
      },
    ],
    [
      "a dead daemon",
      (state) => {
        state.pid = DAEMON_PID + 1;
      },
    ],
  ])("is false for %s", (_label, mutate) => {
    withHealth(mutate, (path) => expect(owns(path)).toBe(false));
  });

  it("matches the deployment by its journal partition", () => {
    withHealth(
      (state) => {
        state.siteUrl = `${SITE_URL}/`;
      },
      (path) => {
        expect(owns(path)).toBe(true);
        expect(owns(path, { siteUrl: "https://API.example.test" })).toBe(true);
        expect(owns(path, { siteUrl: "https://api.example.test.other" })).toBe(false);
      },
    );
  });

  it("fails open when the health file or this CLI's version cannot be read", () => {
    const root = mkdtempSync(join(tmpdir(), "prim-daemon-owner-"));
    try {
      expect(owns(join(root, "missing.json"))).toBe(false);
      writeFileSync(join(root, "torn.json"), '{"schemaVersion":1,');
      expect(owns(join(root, "torn.json"))).toBe(false);
      writeFileSync(join(root, "shape.json"), '{"schemaVersion":1,"heartbeat":[]}');
      expect(owns(join(root, "shape.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    withHealth(
      () => undefined,
      (path) => expect(owns(path, { expectedVersion: null })).toBe(false),
    );
  });
});

function listen(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("test server did not bind a TCP port"));
        return;
      }
      resolve(address.port);
    });
  });
}

async function eventually(predicate: () => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
}

describe("opportunistic flush from a real CLI invocation (PRI-68)", () => {
  it("lets a non-exiting command finish while a detached child drains a delayed backlog", async () => {
    const root = mkdtempSync(join(tmpdir(), "prim-background-flush-"));
    const pkg = join(root, "pkg");
    const home = join(root, "home");
    const config = join(home, ".config", "prim");
    const organization = "org-test";
    mkdirSync(pkg, { recursive: true });
    mkdirSync(config, { recursive: true, mode: 0o700 });
    writeFileSync(join(config, "token"), "test-access\n");
    writeFileSync(join(config, "refresh_token"), "test-refresh\n");
    writeFileSync(join(config, "token_expires_at"), `${String(Date.now() + 3_600_000)}\n`);

    // Ingest never answers until teardown: an in-process drain would hold the
    // command until its 10s request timeout; a detached one cannot.
    let ingestRequests = 0;
    const sockets = new Set<Socket>();
    const server = createServer((request, response) => {
      if (request.method === "GET" && request.url === "/api/cli/auth/status") {
        response.writeHead(200, { "Content-Type": "application/json" });
        response.end(
          JSON.stringify({
            authenticated: true,
            organizationBindingVersion: 1,
            captureAuthorityKind: "workos",
            organizationId: organization,
            workosOrganizationId: organization,
          }),
        );
        return;
      }
      if (request.method === "POST" && request.url === "/api/cli/moves/ingest") {
        ingestRequests += 1;
        request.resume();
        return;
      }
      response.writeHead(404, { "Content-Type": "application/json" });
      response.end("{}");
    });
    server.on("connection", (socket) => {
      sockets.add(socket);
      socket.once("close", () => sockets.delete(socket));
    });
    let drainPid: number | undefined;

    try {
      const port = await listen(server);
      const bucket = join(config, "moves", `127.0.0.1_${String(port)}`, organization);
      mkdirSync(bucket, { recursive: true, mode: 0o700 });
      const capturedAt = Date.now() - 2 * 86_400_000;
      writeFileSync(
        join(bucket, "journal.ndjson"),
        `${Array.from({ length: 50 }, (_, index) =>
          JSON.stringify({
            moveId: `queued-${String(index)}`,
            capturedAt: capturedAt + index,
            sessionId: "queued-session",
            eventType: "UserPromptSubmit",
            payload: { prompt: `queued ${String(index)}` },
          }),
        ).join("\n")}\n`,
        { mode: 0o600 },
      );
      await build({
        entry: [join(process.cwd(), "src/index.ts")],
        format: ["esm"],
        outDir: join(pkg, "dist"),
        platform: "node",
        target: "node20",
        splitting: false,
        clean: true,
        silent: true,
      });
      // The bundle resolves its own package root (version, bins) like a real
      // install; dependencies stay external, so link this checkout's.
      writeFileSync(
        join(pkg, "package.json"),
        JSON.stringify({
          name: "@primitive.ai/prim",
          version: "0.0.0-test",
          type: "module",
          bin: { prim: "dist/index.js" },
        }),
      );
      symlinkSync(join(process.cwd(), "node_modules"), join(pkg, "node_modules"), "dir");

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        HOME: home,
        USERPROFILE: home,
        PRIM_CONFIG_DIR: config,
        PRIM_API_URL: `http://127.0.0.1:${String(port)}`,
        NO_UPDATE_NOTIFIER: "1",
      };
      env.PRIM_TOKEN = undefined;
      const startedAt = Date.now();
      // Piped stdio, like setup's spawnSync capture: `close` waits for every
      // holder of those pipes, so an inherited-stdio drain would hold it too.
      const command = spawn(process.execPath, [join(pkg, "dist", "index.js"), "moves", "status"], {
        cwd: home,
        env,
        stdio: ["ignore", "pipe", "pipe"],
      });
      command.stdout.resume();
      command.stderr.resume();
      // Bounded well below the drain's 10s request timeout, so a command held
      // by an in-process drain fails here instead of at the test timeout.
      const code = await new Promise<number | null | "held">((resolve, reject) => {
        const held = setTimeout(() => {
          command.kill("SIGKILL");
          resolve("held");
        }, 8_000);
        command.once("error", reject);
        command.once("close", (exitCode) => {
          clearTimeout(held);
          resolve(exitCode);
        });
      });
      const elapsedMs = Date.now() - startedAt;

      expect(code).toBe(0);
      expect(elapsedMs).toBeLessThan(8_000);
      // The backlog was still handed off: a separate process owns the drain
      // lock and reached the ingest endpoint.
      const lockOwner = join(config, ".flush.lock", "owner.json");
      expect(await eventually(() => ingestRequests > 0 && existsSync(lockOwner), 10_000)).toBe(
        true,
      );
      drainPid = (JSON.parse(readFileSync(lockOwner, "utf8")) as { pid: number }).pid;
      expect(drainPid).not.toBe(command.pid);
      expect(processIsAlive(drainPid)).toBe(true);
    } finally {
      for (const socket of sockets) socket.destroy();
      server.close();
      if (drainPid !== undefined) {
        const pid = drainPid;
        if (!(await eventually(() => !processIsAlive(pid), 15_000))) process.kill(pid, "SIGKILL");
      }
      rmSync(root, { recursive: true, force: true });
    }
  }, 45_000);
});
