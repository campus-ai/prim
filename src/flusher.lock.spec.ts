/**
 * The flush lock serializes drains ACROSS prim processes. The Stop hook spawns
 * a detached `prim moves flush` alongside the daemon and opportunistic command
 * flushes, so without a machine-wide lock multiple processes adopt the same
 * crash-stranded `.flushing` orphans and re-POST them concurrently — the
 * amplification behind the incident's duplicate-ingest flood. These pin the two
 * observable outcomes: an uncontended flush drains; a contended one bows out.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockedHome = vi.hoisted(() => ({ value: "" }));

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, homedir: () => mockedHome.value };
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("flush lock", () => {
  const originalEnv = { ...process.env };
  let home: string;
  let config: string;

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    process.env = { ...originalEnv };
    Reflect.deleteProperty(process.env, "PRIM_TOKEN");
    Reflect.deleteProperty(process.env, "PRIM_API_URL");
    Reflect.deleteProperty(process.env, "PRIM_CONFIG_DIR");
    Reflect.deleteProperty(process.env, "XDG_CONFIG_HOME");
    home = mkdtempSync(join(tmpdir(), "prim-flush-lock-"));
    mockedHome.value = home;
    config = join(home, ".config", "prim");
    mkdirSync(config, { recursive: true });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.env = originalEnv;
    rmSync(home, { recursive: true, force: true });
  });

  it("drains the journal when the lock is free", async () => {
    writeFileSync(join(config, "token"), "test-token\n");
    const posts: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((url: string | URL | Request) => {
        posts.push(String(url));
        return Promise.resolve(
          jsonResponse({ accepted: 1, acknowledged: 1, disposition: "persisted" }),
        );
      }),
    );

    const { appendMove } = await import("./journal.js");
    const { flush } = await import("./flusher.js");
    appendMove(
      {
        moveId: "m1",
        capturedAt: 1,
        sessionId: "s",
        eventType: "PostToolUse",
        payload: { ok: true },
        env: { cwd: "/repo", cliVersion: "x", osPlatform: "darwin" },
        envelopeVersion: 1,
      },
      "org1",
    );

    await expect(flush()).resolves.toEqual({ flushed: 1 });
    expect(posts.some((u) => u.endsWith("/api/cli/moves/ingest"))).toBe(true);
  });

  it("bows out without draining when another process holds the lock", async () => {
    writeFileSync(join(config, "token"), "test-token\n");
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const { JOURNAL_DIR, appendMove, readMovesFromPath, journalPath } = await import(
      "./journal.js"
    );
    appendMove(
      {
        moveId: "m1",
        capturedAt: 1,
        sessionId: "s",
        eventType: "PostToolUse",
        payload: { ok: true },
        env: { cwd: "/repo", cliVersion: "x", osPlatform: "darwin" },
        envelopeVersion: 1,
      },
      "org1",
    );
    const bucketPath = journalPath("org1");

    // Hold the machine-wide flush lock with this (alive) process as owner, so
    // the lock is never reclaimed as stale during the attempt.
    const lockDir = join(dirname(JOURNAL_DIR), ".flush.lock");
    mkdirSync(lockDir, { recursive: true });
    writeFileSync(
      join(lockDir, "owner.json"),
      `${JSON.stringify({ pid: process.pid, nonce: "held", createdAt: Date.now() })}\n`,
    );

    const { flush } = await import("./flusher.js");
    await expect(flush()).resolves.toEqual({ flushed: 0, skipped: true });
    // No POST fired, and the move is still journaled for the lock holder.
    expect(fetchMock).not.toHaveBeenCalled();
    expect(readMovesFromPath(bucketPath).map((m) => m.moveId)).toEqual(["m1"]);
  });
});
