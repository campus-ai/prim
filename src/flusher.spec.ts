/**
 * Flusher invariants the orphan-recovery sweep depends on.
 *
 * Recovery re-reads and re-POSTs a stranded `.flushing` file; that replay is
 * only safe because (1) batching is a pure, order- and identity-preserving
 * slice of the move list, and (2) a journal→`.flushing` rotation re-reads with
 * the original moveIds, so the server dedups the replay at by_move_id. The
 * network drain itself is exercised by the release smoke; these pin the pure
 * pieces.
 */
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type CliClient, HttpError } from "./client.js";
import {
  type DeadLetterRecord,
  deadLetterDirectoryForRotation,
  deadLetterPathForMove,
} from "./dead-letter.js";
import {
  batchMoves,
  drainFlushingPath,
  processIsAlive,
  recoverOrphans,
  selectRecoverable,
  shouldFlushPending,
} from "./flusher.js";
import { IngestAcknowledgementError } from "./ingest-response.js";
import { type FlushingFile, appendMoveToPath, readMovesFromPath } from "./journal.js";
import type { Move } from "./protocol/move.js";

function move(id: string): Move {
  return {
    moveId: id,
    capturedAt: 1,
    sessionId: "s",
    eventType: "PostToolUse",
    payload: { ok: true },
    env: { cwd: "/repo", cliVersion: "x", osPlatform: "darwin" },
    envelopeVersion: 1,
  };
}

describe("batchMoves", () => {
  it("returns no batches for an empty list", () => {
    expect(batchMoves([], 500)).toEqual([]);
  });

  it("keeps a sub-batch list in a single batch, in order", () => {
    const batches = batchMoves([move("a"), move("b"), move("c")], 500);
    expect(batches).toHaveLength(1);
    expect(batches[0].map((m) => m.moveId)).toEqual(["a", "b", "c"]);
  });

  it("splits on the batch boundary without dropping or reordering moves", () => {
    const moves = Array.from({ length: 1100 }, (_, i) => move(`m${i}`));
    const batches = batchMoves(moves, 500);
    expect(batches.map((b) => b.length)).toEqual([500, 500, 100]);
    // Concatenation round-trips to the original order and identity.
    expect(batches.flat().map((m) => m.moveId)).toEqual(moves.map((m) => m.moveId));
  });
});

describe("opportunistic age", () => {
  it("uses capturedAt and flushes an orphan-only queue", () => {
    expect(
      shouldFlushPending(
        {
          pendingCount: 2,
          oldestPendingAt: 10_000,
          strandedCount: 2,
          strandedFileCount: 1,
          sampled: false,
          strandedSampled: false,
        },
        80_001,
        60_000,
      ),
    ).toBe(true);
  });

  it("does not mistake a new mtime-equivalent queue for overdue work", () => {
    expect(
      shouldFlushPending(
        {
          pendingCount: 1,
          oldestPendingAt: 79_000,
          strandedCount: 0,
          strandedFileCount: 0,
          sampled: false,
          strandedSampled: false,
        },
        80_000,
        60_000,
      ),
    ).toBe(false);
  });

  it("flushes a sampled lower bound even when the observed count is zero", () => {
    expect(
      shouldFlushPending(
        {
          pendingCount: 0,
          strandedCount: 0,
          strandedFileCount: 0,
          sampled: true,
          strandedSampled: false,
        },
        80_000,
        60_000,
      ),
    ).toBe(true);
  });
});

describe("flush replay stability", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-flush-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("a journal→.flushing rotation re-reads with identical moveIds", () => {
    const journal = join(dir, "journal.ndjson");
    for (const m of [move("x1"), move("x2"), move("x3")]) {
      appendMoveToPath(journal, m);
    }

    // Mirror drainPath's rotate step, then re-read as the recovery sweep will.
    const flushing = `${journal}.flushing.1700000000000.4242`;
    renameSync(journal, flushing);

    expect(readMovesFromPath(flushing).map((m) => m.moveId)).toEqual(["x1", "x2", "x3"]);
  });

  function fakeClient(result: unknown): CliClient {
    return {
      get: vi.fn(),
      post: vi.fn().mockResolvedValue(result),
    };
  }

  it("unlinks only after a full durable acknowledgement, including dedup", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("dedup"));
    const client = fakeClient({ disposition: "persisted", acknowledged: 1, accepted: 0 });

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 1,
      quarantined: 0,
    });
    expect(existsSync(flushing)).toBe(false);
    expect(client.post).toHaveBeenCalledWith(
      "/api/cli/moves/ingest",
      { batch: [move("dedup")] },
      { signal: expect.any(AbortSignal) },
    );
  });

  it.each([
    ["legacy response", { accepted: 1 }],
    ["partial acknowledgement", { disposition: "persisted", acknowledged: 0, accepted: 0 }],
    ["wrong disposition", { disposition: "disabled", acknowledged: 1, accepted: 0 }],
    ["malformed response", null],
  ])("retains the rotation after a %s", async (_label, response) => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("retain"));

    await expect(drainFlushingPath(flushing, fakeClient(response))).rejects.toBeInstanceOf(
      IngestAcknowledgementError,
    );
    expect(existsSync(flushing)).toBe(true);
  });

  it("retains the rotation after an HTTP or transport failure", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("offline"));
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new Error("HTTP 503")),
    };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow("HTTP 503");
    expect(existsSync(flushing)).toBe(true);
  });

  it("streams a large rotation in bounded batches without reordering", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    const moves = Array.from({ length: 1_201 }, (_, index) => move(`large-${String(index)}`));
    for (const item of moves) {
      appendMoveToPath(flushing, item);
    }
    const delivered: string[] = [];
    const batchSizes: number[] = [];
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockImplementation((_path, body: { batch: Move[] }) => {
        batchSizes.push(body.batch.length);
        delivered.push(...body.batch.map((item) => item.moveId));
        return Promise.resolve({
          disposition: "persisted",
          acknowledged: body.batch.length,
          accepted: body.batch.length,
        });
      }),
    };

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 1_201,
      quarantined: 0,
    });
    expect(batchSizes).toEqual([500, 500, 201]);
    expect(delivered).toEqual(moves.map((item) => item.moveId));
    expect(existsSync(flushing)).toBe(false);
  });

  function readDeadLetters(flushingPath: string): DeadLetterRecord[] {
    const directory = deadLetterDirectoryForRotation(flushingPath);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map((name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as DeadLetterRecord);
  }

  it("durably quarantines a direct move_id_conflict without persisting server prose", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("foreign"));
    const client: CliClient = {
      get: vi.fn(),
      post: vi
        .fn()
        .mockRejectedValue(
          new HttpError(409, "attacker-controlled message", { error: "move_id_conflict" }),
        ),
    };

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 0,
      quarantined: 1,
    });
    expect(existsSync(flushing)).toBe(false);
    const deadLetters = readDeadLetters(flushing);
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0]).toMatchObject({
      version: 1,
      reason: "move_id_conflict",
      move: { moveId: "foreign" },
    });
    expect(JSON.stringify(deadLetters[0])).not.toContain("attacker-controlled");
    expect(statSync(deadLetterPathForMove(flushing, move("foreign"))).mode & 0o777).toBe(0o600);
  });

  it("bisects a mixed 400 batch, acknowledging valid neighbors and quarantining only poison", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    for (const item of [move("good-a"), move("poison"), move("good-b")]) {
      appendMoveToPath(flushing, item);
    }
    const delivered: string[] = [];
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockImplementation((_path, body: { batch: Move[] }) => {
        if (body.batch.some((item) => item.moveId === "poison")) {
          return Promise.reject(new HttpError(400, "Malformed move(s) in batch"));
        }
        delivered.push(...body.batch.map((item) => item.moveId));
        return Promise.resolve({
          disposition: "persisted",
          acknowledged: body.batch.length,
          accepted: body.batch.length,
        });
      }),
    };

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 2,
      quarantined: 1,
    });
    expect(delivered).toEqual(["good-a", "good-b"]);
    expect(readDeadLetters(flushing).map((record) => record.move.moveId)).toEqual(["poison"]);
    expect(existsSync(flushing)).toBe(false);
  });

  it("replays acknowledged and quarantined halves safely after a later transport failure", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("poison"));
    appendMoveToPath(flushing, move("later"));
    let laterAttempts = 0;
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockImplementation((_path, body: { batch: Move[] }) => {
        if (body.batch.some((item) => item.moveId === "poison")) {
          return Promise.reject(new HttpError(400, "Malformed move(s) in batch"));
        }
        laterAttempts += 1;
        if (laterAttempts === 1) {
          return Promise.reject(new Error("offline"));
        }
        return Promise.resolve({
          disposition: "persisted",
          acknowledged: body.batch.length,
          accepted: body.batch.length,
        });
      }),
    };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow("offline");
    expect(existsSync(flushing)).toBe(true);
    const firstQuarantine = readDeadLetters(flushing)[0];

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 1,
      quarantined: 1,
    });
    const records = readDeadLetters(flushing);
    expect(records).toHaveLength(1);
    expect(records[0].quarantineId).toBe(firstQuarantine.quarantineId);
    expect(existsSync(flushing)).toBe(false);
  });

  it("retains a 409 that is not the coded move ownership conflict", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("retry"));
    const client: CliClient = {
      get: vi.fn(),
      post: vi
        .fn()
        .mockRejectedValue(new HttpError(409, "retry later", { error: "state_conflict" })),
    };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow("retry later");
    expect(existsSync(flushing)).toBe(true);
    expect(existsSync(deadLetterDirectoryForRotation(flushing))).toBe(false);
  });

  it("retains the source rotation when durable quarantine cannot be written", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("poison"));
    // Block creation of the required hardened directory.
    writeFileSync(deadLetterDirectoryForRotation(flushing), "not a directory");
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new HttpError(400, "Malformed move(s) in batch")),
    };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow();
    expect(existsSync(flushing)).toBe(true);
  });
});

describe("processIsAlive", () => {
  it("treats EPERM as proof that the process exists", () => {
    const probe = vi.fn(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    expect(processIsAlive(42, probe)).toBe(true);
  });

  it("treats ESRCH as a dead process", () => {
    const probe = vi.fn(() => {
      throw Object.assign(new Error("not found"), { code: "ESRCH" });
    });
    expect(processIsAlive(42, probe)).toBe(false);
  });
});

describe("selectRecoverable", () => {
  const now = 1_000_000;
  const dead = () => false;
  const alive = () => true;

  function flushing(over: Partial<FlushingFile>): FlushingFile {
    return {
      bucket: "orgA",
      path: "/x",
      pid: undefined,
      sizeBytes: 0,
      mtimeMs: 0,
      lineCount: 0,
      sampled: false,
      sampledBytes: 0,
      ...over,
    };
  }

  it("adopts a file whose owning pid is dead (the crash case)", () => {
    const f = flushing({ pid: 4242, mtimeMs: now });
    expect(selectRecoverable([f], now, { isAlive: dead })).toEqual([f]);
  });

  it("never steals a file whose owning pid is still alive (in-flight drain)", () => {
    const f = flushing({ pid: 4242, mtimeMs: now });
    expect(selectRecoverable([f], now, { isAlive: alive })).toEqual([]);
  });

  it("reclaims a failed rotation owned by this serialized process", () => {
    const f = flushing({ pid: 4242, mtimeMs: now });
    expect(selectRecoverable([f], now, { isAlive: alive, ownerPid: 4242 })).toEqual([f]);
  });

  it("adopts a legacy pid-less file only once it has aged past the quarantine", () => {
    const stale = flushing({ pid: undefined, mtimeMs: now - 120_000 });
    const fresh = flushing({ pid: undefined, mtimeMs: now - 1_000 });
    expect(selectRecoverable([stale, fresh], now, { quarantineMs: 60_000 })).toEqual([stale]);
  });

  it("recovers oldest-first and stops one failed bucket without starving others", async () => {
    const files = [
      flushing({ bucket: "orgA", path: "/a-new", mtimeMs: 200_000 }),
      flushing({ bucket: "orgB", path: "/b-old", mtimeMs: 150_000 }),
      flushing({ bucket: "orgA", path: "/a-old", mtimeMs: 100_000 }),
    ];
    const calls: string[] = [];
    const result = await recoverOrphans(files, {
      now,
      drain: vi.fn().mockImplementation((path: string) => {
        calls.push(path);
        return path === "/a-old"
          ? Promise.reject(new Error("disabled"))
          : Promise.resolve({ flushed: 1, quarantined: 0 });
      }),
    });

    expect(calls).toEqual(["/a-old", "/b-old"]);
    expect(result.flushed).toBe(1);
    expect(result.failedBuckets).toEqual(new Set(["orgA"]));
    expect(result.errors).toHaveLength(1);
  });

  it("reaches another bucket beyond a legacy backlog larger than the old cap", async () => {
    const files = [
      ...Array.from({ length: 129 }, (_, index) =>
        flushing({
          bucket: "orgA",
          path: `/a-${String(index)}`,
          mtimeMs: 100_000 + index,
        }),
      ),
      flushing({ bucket: "orgB", path: "/b", mtimeMs: 300_000 }),
    ];
    const calls: string[] = [];
    await recoverOrphans(files, {
      now,
      drain: vi.fn().mockImplementation((path: string) => {
        calls.push(path);
        return path.startsWith("/a-")
          ? Promise.reject(new Error("disabled"))
          : Promise.resolve({ flushed: 1, quarantined: 0 });
      }),
    });

    expect(calls).toEqual(["/a-0", "/b"]);
  });
});
