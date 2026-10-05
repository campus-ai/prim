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
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
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

type AtomicWriteFile = typeof import("./lib/atomic-file.js").atomicWriteFile;

// Dead-letter directory fsyncs are stubbed so tests can fail them. Checkpoint
// writes stay real behind a recording spy, so the two can be ordered; the spy's
// base implementation delegates, so a mock reset or restore keeps it real.
const mocks = vi.hoisted(() => {
  const real: { atomicWriteFile?: AtomicWriteFile } = {};
  return {
    real,
    syncDirectory: vi.fn(),
    atomicWriteFile: vi.fn<AtomicWriteFile>((...args) => {
      if (real.atomicWriteFile === undefined) {
        throw new Error("atomic-file mock is not wired");
      }
      real.atomicWriteFile(...args);
    }),
  };
});

vi.mock("./lib/atomic-file.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./lib/atomic-file.js")>();
  mocks.real.atomicWriteFile = actual.atomicWriteFile;
  return { ...actual, syncDirectory: mocks.syncDirectory, atomicWriteFile: mocks.atomicWriteFile };
});

import { type CliClient, HttpError } from "./client.js";
import {
  type AnyDeadLetterRecord,
  type DeadLetterRecord,
  deadLetterDirectoryForRotation,
  deadLetterPathForMove,
  deadLetterPathForRawLine,
} from "./dead-letter.js";
import {
  type DrainCheckpoint,
  type RotationIdentity,
  drainProgressDirectory,
  drainProgressPath,
  rotationIdentity,
  writeDrainCheckpoint,
} from "./drain-progress.js";
import {
  BATCH_MAX_BYTES,
  type DrainCounts,
  batchMoves,
  drainFlushingPath as drainOrganizationBoundFlushingPath,
  hasPendingDrainWork,
  recoverOrphans,
  selectRecoverable,
  shouldFlushPending,
} from "./flusher.js";
import { IngestAcknowledgementError } from "./ingest-response.js";
import type { CurrentOrganizationBinding } from "./journal-organization.js";
import {
  type FlushingFile,
  type PendingJournalStats,
  appendMoveToPath,
  listFlushingInDir,
  readMovesFromPath,
} from "./journal.js";
import type { Move } from "./protocol/move.js";

const binding: CurrentOrganizationBinding = {
  captureAuthorityKind: "workos",
  organizationId: "org_local",
  workosOrganizationId: "org_workos",
};

function drainFlushingPath(
  flushingPath: string,
  client: CliClient,
  options?: Parameters<typeof drainOrganizationBoundFlushingPath>[3],
) {
  return drainOrganizationBoundFlushingPath(flushingPath, client, binding, options);
}

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

  it("closes a batch before its journal lines exceed the byte bound", () => {
    const lineBytes = Buffer.byteLength(`${JSON.stringify(move("a"))}\n`);
    const moves = [move("a"), move("b"), move("c")];

    expect(batchMoves(moves, 500, lineBytes * 2).map((b) => b.map((m) => m.moveId))).toEqual([
      ["a", "b"],
      ["c"],
    ]);
    // A move larger than the bound is still sent, alone.
    expect(batchMoves(moves, 500, 1).map((b) => b.length)).toEqual([1, 1, 1]);
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

  const idle: PendingJournalStats = {
    pendingCount: 0,
    strandedCount: 0,
    strandedFileCount: 0,
    sampled: false,
    strandedSampled: false,
  };

  it("flushes a stranded rotation that holds nothing left to deliver", () => {
    // A rotation whose checkpoint covers every line has no move and no age,
    // but only a drain unlinks it.
    const retirable = { ...idle, strandedFileCount: 1 };
    expect(hasPendingDrainWork(retirable)).toBe(true);
    expect(shouldFlushPending(retirable, 80_000, 60_000)).toBe(true);
  });

  it("finds no drain work only when nothing is pending, sampled, or stranded", () => {
    expect(hasPendingDrainWork(idle)).toBe(false);
    expect(shouldFlushPending(idle, 80_000, 60_000)).toBe(false);
    expect(hasPendingDrainWork({ ...idle, pendingCount: 1, oldestPendingAt: 79_000 })).toBe(true);
    expect(hasPendingDrainWork({ ...idle, sampled: true })).toBe(true);
    // A young stranded backlog still waits for its age, as before.
    expect(
      shouldFlushPending(
        {
          ...idle,
          pendingCount: 1,
          strandedCount: 1,
          strandedFileCount: 1,
          oldestPendingAt: 79_000,
        },
        80_000,
        60_000,
      ),
    ).toBe(false);
  });
});

describe("flush replay stability", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-flush-"));
    mocks.syncDirectory.mockReset();
    mocks.atomicWriteFile.mockClear();
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
      {
        batch: [
          expect.objectContaining({
            moveId: "dedup",
            envelopeVersion: 4,
            capturedOrganizationId: "org_workos",
            captureAuthorityKind: "workos",
            decisionLifecycleProtocolVersion: 2,
          }),
        ],
      },
      { signal: expect.any(AbortSignal) },
    );
  });

  it("keeps the additive-field compatibility policy for durable acknowledgements", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("older-server"));

    await expect(
      drainFlushingPath(flushing, fakeClient({ disposition: "persisted", acknowledged: 1 })),
    ).resolves.toEqual({ flushed: 1, quarantined: 0 });
    expect(existsSync(flushing)).toBe(false);
  });

  it("delivers a legacy move without env provenance when the response has scope drift", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, { ...move("legacy-env"), env: undefined } as unknown as Move);

    await expect(
      drainFlushingPath(
        flushing,
        fakeClient({ disposition: "persisted", acknowledged: 1, collectScopeVersion: 2 }),
      ),
    ).resolves.toEqual({ flushed: 1, quarantined: 0 });
    expect(existsSync(flushing)).toBe(false);
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

  function readDeadLetters(flushingPath: string): AnyDeadLetterRecord[] {
    const directory = deadLetterDirectoryForRotation(flushingPath);
    return readdirSync(directory)
      .filter((name) => name.endsWith(".json"))
      .sort()
      .map(
        (name) => JSON.parse(readFileSync(join(directory, name), "utf8")) as AnyDeadLetterRecord,
      );
  }

  function moveDeadLetters(flushingPath: string): DeadLetterRecord[] {
    return readDeadLetters(flushingPath).filter(
      (record): record is DeadLetterRecord => !("recordKind" in record),
    );
  }

  it("quarantines a malformed local envelope before any transport", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    writeFileSync(flushing, `${JSON.stringify({ moveId: "malformed" })}\n`);
    const client = fakeClient({ disposition: "persisted", acknowledged: 1 });

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 0,
      quarantined: 1,
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(moveDeadLetters(flushing)).toEqual([
      expect.objectContaining({
        reason: "invalid_move",
        move: { moveId: "malformed" },
      }),
    ]);
  });

  it("durably quarantines syntax-invalid exact bytes before unlinking or transport", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    const rawLine = Buffer.from('{"moveId":"secret-marker"\r\n', "utf8");
    writeFileSync(flushing, rawLine);
    const client = fakeClient({ disposition: "persisted", acknowledged: 1 });
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);

    const result = await drainFlushingPath(flushing, client);
    const terminalOutput = stderr.mock.calls.flat().join("");
    stderr.mockRestore();

    expect(result).toEqual({ flushed: 0, quarantined: 1 });
    expect(terminalOutput).not.toContain("secret-marker");
    expect(client.post).not.toHaveBeenCalled();
    expect(existsSync(flushing)).toBe(false);
    expect(readDeadLetters(flushing)).toEqual([
      expect.objectContaining({
        version: 1,
        recordKind: "raw_line_v1",
        quarantineId: createHash("sha256").update(rawLine).digest("hex"),
        reason: "invalid_move",
        rawLineEncoding: "base64",
        rawLineBytes: rawLine.length,
        rawLine: rawLine.toString("base64"),
      }),
    ]);
    expect(statSync(deadLetterDirectoryForRotation(flushing)).mode & 0o777).toBe(0o700);
    expect(statSync(deadLetterPathForRawLine(flushing, rawLine)).mode & 0o777).toBe(0o600);
  });

  it("quarantines invalid UTF-8 without replacement or transport", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    const rawLine = Buffer.from([0x7b, 0x22, 0x6d, 0x22, 0x3a, 0xc3, 0x28, 0x7d, 0x0a]);
    writeFileSync(flushing, rawLine);
    const client = fakeClient({ disposition: "persisted", acknowledged: 1 });

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 0,
      quarantined: 1,
    });
    expect(client.post).not.toHaveBeenCalled();
    expect(readDeadLetters(flushing)).toEqual([
      expect.objectContaining({
        recordKind: "raw_line_v1",
        rawLineEncoding: "base64",
        rawLine: rawLine.toString("base64"),
      }),
    ]);
  });

  it("replays raw-line quarantine idempotently after a crash before source unlink", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    const rawLine = Buffer.from('{"moveId":\n', "utf8");
    const client = fakeClient({ disposition: "persisted", acknowledged: 1 });

    writeFileSync(flushing, rawLine);
    await drainFlushingPath(flushing, client);
    const first = readDeadLetters(flushing);

    // Recreate the source bytes to model a crash after the atomic dead-letter
    // rename but before the source rotation unlink.
    writeFileSync(flushing, rawLine);
    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 0,
      quarantined: 1,
    });
    expect(readDeadLetters(flushing)).toEqual(first);
    expect(client.post).not.toHaveBeenCalled();
  });

  it("retains syntax-invalid source bytes when raw-line quarantine cannot be written", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    const rawLine = Buffer.from('{"moveId":\n', "utf8");
    writeFileSync(flushing, rawLine);
    // Block creation of the hardened dead-letter directory.
    writeFileSync(deadLetterDirectoryForRotation(flushing), "not a directory");
    const client = fakeClient({ disposition: "persisted", acknowledged: 1 });

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow();
    expect(client.post).not.toHaveBeenCalled();
    expect(existsSync(flushing)).toBe(true);
    expect(readFileSync(flushing)).toEqual(rawLine);
  });

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

  it("durably quarantines an exact capture authority mismatch as tenant_mismatch", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("wrong-tenant"));
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(
        new HttpError(409, "capture authority mismatch", {
          error: "capture_authority_mismatch",
        }),
      ),
    };

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 0,
      quarantined: 1,
    });
    expect(existsSync(flushing)).toBe(false);
    expect(readDeadLetters(flushing)).toEqual([
      expect.objectContaining({
        version: 1,
        reason: "tenant_mismatch",
        move: expect.objectContaining({ moveId: "wrong-tenant" }),
      }),
    ]);
  });

  it("bisects a versioned invalid-move batch, acknowledging valid neighbors and quarantining only poison", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    for (const item of [move("good-a"), move("poison"), move("good-b")]) {
      appendMoveToPath(flushing, item);
    }
    const delivered: string[] = [];
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockImplementation((_path, body: { batch: Move[] }) => {
        if (body.batch.some((item) => item.moveId === "poison")) {
          return Promise.reject(
            new HttpError(400, "Malformed move(s) in batch", {
              error: "invalid_move",
              errorVersion: 1,
            }),
          );
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
    expect(moveDeadLetters(flushing).map((record) => record.move.moveId)).toEqual(["poison"]);
    expect(existsSync(flushing)).toBe(false);
  });

  it("bisects an exact tenant mismatch while acknowledging valid neighbors", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    for (const item of [move("good-a"), move("wrong-tenant"), move("good-b")]) {
      appendMoveToPath(flushing, item);
    }
    const delivered: string[] = [];
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockImplementation((_path, body: { batch: Move[] }) => {
        if (body.batch.some((item) => item.moveId === "wrong-tenant")) {
          return Promise.reject(
            new HttpError(409, "capture authority mismatch", {
              error: "capture_authority_mismatch",
            }),
          );
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
    expect(readDeadLetters(flushing)).toEqual([
      expect.objectContaining({
        reason: "tenant_mismatch",
        move: expect.objectContaining({ moveId: "wrong-tenant" }),
      }),
    ]);
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
          return Promise.reject(
            new HttpError(400, "Malformed move(s) in batch", {
              error: "invalid_move",
              errorVersion: 1,
            }),
          );
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
    // Model a lost checkpoint write: the replay it forces must stay idempotent.
    rmSync(drainProgressPath(flushing));

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

  it("retains the source when the post-rename dead-letter sync fails", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("poison"));
    mocks.syncDirectory
      .mockImplementationOnce(() => {})
      .mockImplementationOnce(() => {
        throw new Error("dead-letter sync failed");
      });
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(
        new HttpError(400, "Malformed move(s) in batch", {
          error: "invalid_move",
          errorVersion: 1,
        }),
      ),
    };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow("dead-letter sync failed");
    expect(existsSync(flushing)).toBe(true);
    expect(existsSync(deadLetterPathForMove(flushing, move("poison")))).toBe(true);
  });

  it("re-syncs an existing dead letter before retiring its replayed source", async () => {
    const first = join(dir, "journal.ndjson.flushing.1.2");
    const replay = join(dir, "journal.ndjson.flushing.3.4");
    const poisoned = move("poison");
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(
        new HttpError(400, "Malformed move(s) in batch", {
          error: "invalid_move",
          errorVersion: 1,
        }),
      ),
    };
    appendMoveToPath(first, poisoned);
    await expect(drainFlushingPath(first, client)).resolves.toEqual({ flushed: 0, quarantined: 1 });

    mocks.syncDirectory.mockClear();
    appendMoveToPath(replay, poisoned);
    await expect(drainFlushingPath(replay, client)).resolves.toEqual({
      flushed: 0,
      quarantined: 1,
    });
    expect(mocks.syncDirectory).toHaveBeenCalledWith(deadLetterDirectoryForRotation(replay));
  });

  it.each([
    ["legacy generic error", { error: "Malformed move(s) in batch" }],
    ["unversioned invalid move", { error: "invalid_move" }],
    ["unknown invalid-move version", { error: "invalid_move", errorVersion: 2 }],
    ["extended invalid-move response", { error: "invalid_move", errorVersion: 1, detail: "x" }],
  ])("retains a %s 400 for retry", async (_label, body) => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("retry"));
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockRejectedValue(new HttpError(400, "retry later", body)),
    };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow("retry later");
    expect(existsSync(flushing)).toBe(true);
    expect(existsSync(deadLetterDirectoryForRotation(flushing))).toBe(false);
  });

  it("retains a retryable 503 without splitting or quarantining the batch", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("retry-a"));
    appendMoveToPath(flushing, move("retry-b"));
    const post = vi.fn().mockRejectedValue(
      new HttpError(503, "capture authority check unavailable", {
        error: "capture_authority_check_unavailable",
      }),
    );
    const client: CliClient = { get: vi.fn(), post };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow(
      "capture authority check unavailable",
    );
    expect(post).toHaveBeenCalledTimes(1);
    expect(existsSync(flushing)).toBe(true);
    expect(existsSync(deadLetterDirectoryForRotation(flushing))).toBe(false);
  });

  it.each([
    ["a server fault", new HttpError(500, "Too many bytes read", { error: "Too many bytes read" })],
    [
      "a client timeout",
      new DOMException("The operation was aborted due to timeout", "TimeoutError"),
    ],
  ])("bisects an oversized batch after %s without quarantining", async (_label, failure) => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    const moves = [move("size-a"), move("size-b"), move("size-c")];
    for (const item of moves) {
      appendMoveToPath(flushing, item);
    }
    const delivered: string[] = [];
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockImplementation((_path, body: { batch: Move[] }) => {
        if (body.batch.length > 1) {
          return Promise.reject(failure);
        }
        delivered.push(...body.batch.map((item) => item.moveId));
        return Promise.resolve({ disposition: "persisted", acknowledged: 1, accepted: 1 });
      }),
    };

    await expect(drainFlushingPath(flushing, client)).resolves.toEqual({
      flushed: 3,
      quarantined: 0,
    });
    expect(delivered).toEqual(moves.map((item) => item.moveId));
    expect(existsSync(flushing)).toBe(false);
    expect(existsSync(deadLetterDirectoryForRotation(flushing))).toBe(false);
  });

  it("retains the rotation when a single move keeps failing with a server fault", async () => {
    const flushing = join(dir, "journal.ndjson.flushing.1.2");
    appendMoveToPath(flushing, move("fault-a"));
    appendMoveToPath(flushing, move("fault-b"));
    const post = vi.fn().mockRejectedValue(new HttpError(500, "Server Error", null));
    const client: CliClient = { get: vi.fn(), post };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow("Server Error");
    expect(post).toHaveBeenCalledTimes(2);
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
      post: vi.fn().mockRejectedValue(
        new HttpError(400, "Malformed move(s) in batch", {
          error: "invalid_move",
          errorVersion: 1,
        }),
      ),
    };

    await expect(drainFlushingPath(flushing, client)).rejects.toThrow();
    expect(existsSync(flushing)).toBe(true);
  });
});

describe("drain checkpoints and byte-bounded batches", () => {
  let dir: string;
  let flushing: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-drain-progress-"));
    flushing = join(dir, "journal.ndjson.flushing.1.2");
    mocks.syncDirectory.mockReset();
    mocks.atomicWriteFile.mockClear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(dir, { recursive: true, force: true });
  });

  function journalBytes(moves: Move[]): number {
    return moves.reduce((bytes, item) => bytes + Buffer.byteLength(`${JSON.stringify(item)}\n`), 0);
  }

  function writeJournal(moves: Move[]): void {
    for (const item of moves) {
      appendMoveToPath(flushing, item);
    }
  }

  function readCheckpoint(): DrainCheckpoint {
    return JSON.parse(readFileSync(drainProgressPath(flushing), "utf8")) as DrainCheckpoint;
  }

  /** The checkpoint at `offset` for the rotation as it is on disk now. */
  function checkpointAt(offset: number): DrainCheckpoint {
    return { v: 2, offset, ...rotationIdentity(statSync(flushing)) };
  }

  /** Offsets of every checkpoint the drain wrote, in order. */
  function checkpointWrites(): number[] {
    return mocks.atomicWriteFile.mock.calls
      .filter(([target]) => target === drainProgressPath(flushing))
      .map(([, content]) => (JSON.parse(String(content)) as DrainCheckpoint).offset);
  }

  /** Records every POSTed batch's moveIds; `fail` may reject one by returning an error. */
  function recordingClient(fail?: (batch: Move[], call: number) => unknown) {
    const posts: string[][] = [];
    const client: CliClient = {
      get: vi.fn(),
      post: vi.fn().mockImplementation((_path, body: { batch: Move[] }) => {
        posts.push(body.batch.map((item) => item.moveId));
        const failure = fail?.(body.batch, posts.length);
        if (failure !== undefined) {
          return Promise.reject(failure);
        }
        return Promise.resolve({
          disposition: "persisted",
          acknowledged: body.batch.length,
          accepted: body.batch.length,
        });
      }),
    };
    return { client, posts };
  }

  const ids = (moves: Move[]) => moves.map((item) => item.moveId);
  const timeout = () =>
    new DOMException("The operation was aborted due to timeout", "TimeoutError");

  it("resumes at the first unacknowledged batch instead of replaying acknowledged ones", async () => {
    const moves = Array.from({ length: 1_600 }, (_, index) => move(`resume-${String(index)}`));
    writeJournal(moves);
    const failing = recordingClient((_batch, call) =>
      call === 3 ? new Error("offline") : undefined,
    );

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(failing.posts.map((batch) => batch.length)).toEqual([500, 500, 500]);
    expect(readCheckpoint()).toEqual(checkpointAt(journalBytes(moves.slice(0, 1_000))));

    const healthy = recordingClient();
    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 600,
      quarantined: 0,
    });
    // Nothing from the two acknowledged batches is re-sent.
    expect(healthy.posts.flat()).toEqual(ids(moves.slice(1_000)));
    expect(healthy.posts.map((batch) => batch.length)).toEqual([500, 100]);
    expect(existsSync(flushing)).toBe(false);
    expect(existsSync(drainProgressPath(flushing))).toBe(false);
  });

  it("checkpoints a bisected batch's acknowledged left half and resumes at its right half", async () => {
    const moves = [move("half-a"), move("half-b"), move("half-c"), move("half-d")];
    writeJournal(moves);
    const failing = recordingClient((batch) => {
      if (batch.length > 2) {
        return timeout();
      }
      return batch.some((item) => item.moveId === "half-c") ? new Error("offline") : undefined;
    });

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(failing.posts).toEqual([ids(moves), ["half-a", "half-b"], ["half-c", "half-d"]]);
    expect(readCheckpoint()).toEqual(checkpointAt(journalBytes(moves.slice(0, 2))));

    const healthy = recordingClient();
    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 2,
      quarantined: 0,
    });
    expect(healthy.posts).toEqual([["half-c", "half-d"]]);
  });

  it("advances the checkpoint past a quarantined leaf", async () => {
    const moves = [move("poison"), move("later")];
    writeJournal(moves);
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const failing = recordingClient((batch) => {
      if (batch.some((item) => item.moveId === "poison")) {
        return new HttpError(400, "Malformed move(s) in batch", {
          error: "invalid_move",
          errorVersion: 1,
        });
      }
      return new Error("offline");
    });

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(readCheckpoint().offset).toBe(journalBytes(moves.slice(0, 1)));

    const healthy = recordingClient();
    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 1,
      quarantined: 0,
    });
    expect(healthy.posts).toEqual([["later"]]);
    expect(readdirSync(deadLetterDirectoryForRotation(flushing))).toEqual([
      `${createHash("sha256")
        .update(JSON.stringify(move("poison")))
        .digest("hex")}.json`,
    ]);
    expect(existsSync(flushing)).toBe(false);
  });

  it("retires a rotation whose trailing lines are syntax-invalid, even resuming past its last move", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeJournal([move("tail")]);
    writeFileSync(flushing, '{"moveId":\nnot json\r\n', { flag: "a" });
    const source = readFileSync(flushing);

    const first = recordingClient();
    await expect(drainFlushingPath(flushing, first.client)).resolves.toEqual({
      flushed: 1,
      quarantined: 2,
    });
    expect(first.posts).toEqual([["tail"]]);
    expect(existsSync(flushing)).toBe(false);
    expect(existsSync(drainProgressPath(flushing))).toBe(false);
    const deadLetters = readdirSync(deadLetterDirectoryForRotation(flushing)).sort();
    expect(deadLetters).toHaveLength(2);

    // A crash after the last move's checkpoint but before the unlink resumes
    // with only the invalid tail: it is re-quarantined idempotently and the
    // rotation retires without a POST.
    writeFileSync(flushing, source);
    writeDrainCheckpoint(flushing, checkpointAt(journalBytes([move("tail")])));
    const resumed = recordingClient();
    await expect(drainFlushingPath(flushing, resumed.client)).resolves.toEqual({
      flushed: 0,
      quarantined: 2,
    });
    expect(resumed.posts).toEqual([]);
    expect(readdirSync(deadLetterDirectoryForRotation(flushing)).sort()).toEqual(deadLetters);
    expect(existsSync(flushing)).toBe(false);
    expect(existsSync(drainProgressPath(flushing))).toBe(false);
  });

  it("retires a fully checkpointed rotation without re-sending any move", async () => {
    writeJournal([move("done-a"), move("done-b")]);
    writeDrainCheckpoint(flushing, checkpointAt(statSync(flushing).size));
    const healthy = recordingClient();

    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 0,
      quarantined: 0,
    });
    expect(healthy.posts).toEqual([]);
    expect(existsSync(flushing)).toBe(false);
    expect(existsSync(drainProgressPath(flushing))).toBe(false);
  });

  it.each([
    ["corrupt", () => "{not json"],
    [
      "legacy identity-less v1",
      (offset: number, file: RotationIdentity) => JSON.stringify({ v: 1, offset, size: file.size }),
    ],
    [
      "unknown-version",
      (offset: number, file: RotationIdentity) => JSON.stringify({ ...file, v: 3, offset }),
    ],
    [
      "size-mismatched",
      (offset: number, file: RotationIdentity) =>
        JSON.stringify({ ...file, v: 2, offset, size: file.size + 1 }),
    ],
    [
      "other-file",
      (offset: number, file: RotationIdentity) =>
        JSON.stringify({ ...file, v: 2, offset, ino: file.ino + 1 }),
    ],
    [
      "other-device",
      (offset: number, file: RotationIdentity) =>
        JSON.stringify({ ...file, v: 2, offset, dev: file.dev + 1 }),
    ],
    [
      "out-of-range",
      (_offset: number, file: RotationIdentity) =>
        JSON.stringify({ ...file, v: 2, offset: file.size + 1 }),
    ],
    [
      "negative",
      (_offset: number, file: RotationIdentity) => JSON.stringify({ ...file, v: 2, offset: -1 }),
    ],
    [
      "fractional",
      (offset: number, file: RotationIdentity) =>
        JSON.stringify({ ...file, v: 2, offset: offset + 0.5 }),
    ],
  ])("ignores a %s checkpoint and drains from the first line", async (_label, checkpoint) => {
    const moves = [move("from-a"), move("from-b")];
    writeJournal(moves);
    mkdirSync(drainProgressDirectory(flushing));
    writeFileSync(
      drainProgressPath(flushing),
      checkpoint(journalBytes(moves.slice(0, 1)), rotationIdentity(statSync(flushing))),
    );
    const healthy = recordingClient();

    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 2,
      quarantined: 0,
    });
    expect(healthy.posts).toEqual([ids(moves)]);
    expect(existsSync(flushing)).toBe(false);
    expect(existsSync(drainProgressPath(flushing))).toBe(false);
  });

  it("still delivers when progress cannot be recorded, and warns once per failure episode", async () => {
    // A fresh module, so no earlier test has already spent the warning.
    vi.resetModules();
    const fresh = await import("./flusher.js");
    const blockProgress = () => writeFileSync(drainProgressDirectory(flushing), "not a directory");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const warnings = () =>
      stderr.mock.calls
        .flat()
        .filter((chunk) => String(chunk).includes("could not record drain progress"));
    // Two batches each, so each drain attempts one checkpoint.
    const moves = Array.from({ length: 501 }, (_, index) => move(`no-progress-${String(index)}`));
    const drainTwoBatches = (path: string) => {
      for (const item of moves) {
        appendMoveToPath(path, item);
      }
      return fresh.drainFlushingPath(path, recordingClient().client, binding);
    };

    // Block creation of the checkpoint directory.
    blockProgress();
    for (const path of [flushing, join(dir, "journal.ndjson.flushing.3.4")]) {
      await expect(drainTwoBatches(path)).resolves.toEqual({ flushed: 501, quarantined: 0 });
      expect(existsSync(path)).toBe(false);
    }
    expect(warnings()).toHaveLength(1);

    // A successful write ends the episode, so a long-lived daemon still
    // reports a later failure.
    rmSync(drainProgressDirectory(flushing));
    await expect(drainTwoBatches(join(dir, "journal.ndjson.flushing.5.6"))).resolves.toEqual({
      flushed: 501,
      quarantined: 0,
    });
    expect(warnings()).toHaveLength(1);
    blockProgress();
    await expect(drainTwoBatches(join(dir, "journal.ndjson.flushing.7.8"))).resolves.toEqual({
      flushed: 501,
      quarantined: 0,
    });
    expect(warnings()).toHaveLength(2);
  });

  function sizedMove(id: string, payloadBytes: number): Move {
    return { ...move(id), payload: { blob: "x".repeat(payloadBytes) } };
  }

  it("closes batches by raw line bytes without reordering", async () => {
    // Three ~300 KB lines fit under the byte bound; a fourth would not.
    const moves = Array.from({ length: 7 }, (_, index) =>
      sizedMove(`bytes-${String(index)}`, 300_000),
    );
    writeJournal(moves);
    const healthy = recordingClient();

    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 7,
      quarantined: 0,
    });
    expect(healthy.posts.map((batch) => batch.length)).toEqual([3, 3, 1]);
    expect(healthy.posts.flat()).toEqual(ids(moves));
    for (const batch of healthy.posts) {
      expect(journalBytes(moves.filter((item) => batch.includes(item.moveId)))).toBeLessThanOrEqual(
        BATCH_MAX_BYTES,
      );
    }
  });

  it("posts a single line larger than the byte bound alone", async () => {
    const moves = [move("small-a"), sizedMove("oversized", BATCH_MAX_BYTES), move("small-b")];
    writeJournal(moves);
    const healthy = recordingClient();

    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 3,
      quarantined: 0,
    });
    expect(healthy.posts).toEqual([["small-a"], ["oversized"], ["small-b"]]);
    expect(existsSync(flushing)).toBe(false);
  });

  const invalidLine = () => Buffer.from('{"moveId":\n', "utf8");
  const invalidMove = () =>
    new HttpError(400, "Malformed move(s) in batch", { error: "invalid_move", errorVersion: 1 });

  function rawDeadLetters(): string[] {
    return readdirSync(deadLetterDirectoryForRotation(flushing)).filter((name) =>
      name.startsWith("raw-"),
    );
  }

  it("leaves the checkpoint unchanged after a short acknowledgement", async () => {
    const moves = Array.from({ length: 1_200 }, (_, index) => move(`short-${String(index)}`));
    writeJournal(moves);
    const post = vi.fn().mockImplementation((_path, body: { batch: Move[] }) =>
      Promise.resolve({
        disposition: "persisted",
        // The second batch is acknowledged one move short.
        acknowledged: body.batch.length - (post.mock.calls.length === 2 ? 1 : 0),
        accepted: body.batch.length,
      }),
    );

    await expect(drainFlushingPath(flushing, { get: vi.fn(), post })).rejects.toBeInstanceOf(
      IngestAcknowledgementError,
    );
    expect(post).toHaveBeenCalledTimes(2);
    expect(checkpointWrites()).toEqual([journalBytes(moves.slice(0, 500))]);
    expect(readCheckpoint()).toEqual(checkpointAt(journalBytes(moves.slice(0, 500))));
    expect(existsSync(flushing)).toBe(true);
  });

  it("checkpoints past an invalid line inside a bisected batch's acknowledged prefix", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const [first, second, third, fourth] = ["mixed-a", "mixed-b", "mixed-c", "mixed-d"].map(move);
    appendMoveToPath(flushing, first);
    writeFileSync(flushing, invalidLine(), { flag: "a" });
    for (const item of [second, third, fourth]) {
      appendMoveToPath(flushing, item);
    }
    const failing = recordingClient((batch) => {
      if (batch.length > 2) {
        return timeout();
      }
      return batch.some((item) => item.moveId === "mixed-c") ? new Error("offline") : undefined;
    });

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(failing.posts).toEqual([
      ["mixed-a", "mixed-b", "mixed-c", "mixed-d"],
      ["mixed-a", "mixed-b"],
      ["mixed-c", "mixed-d"],
    ]);
    // The left half's last move lies past the invalid line, which is durably
    // quarantined, so the checkpoint covers exactly a, the invalid line, and b.
    expect(readCheckpoint()).toEqual(
      checkpointAt(journalBytes([first]) + invalidLine().length + journalBytes([second])),
    );
    expect(rawDeadLetters()).toHaveLength(1);

    const healthy = recordingClient();
    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 2,
      quarantined: 0,
    });
    expect(healthy.posts).toEqual([["mixed-c", "mixed-d"]]);
    expect(rawDeadLetters()).toHaveLength(1);
    expect(existsSync(flushing)).toBe(false);
  });

  it("resumes an orphan adopted from a dead drain at that drain's checkpoint", async () => {
    const orphan = join(dir, "journal.ndjson.flushing.1700000000000.4242");
    const moves = [move("orphan-a"), move("orphan-b"), move("orphan-c"), move("orphan-d")];
    for (const item of moves) {
      appendMoveToPath(orphan, item);
    }
    // The owning drain acknowledged half the rotation, then died.
    const dying = recordingClient((batch) => {
      if (batch.length > 2) {
        return timeout();
      }
      return batch.some((item) => item.moveId === "orphan-c") ? new Error("offline") : undefined;
    });
    await expect(drainFlushingPath(orphan, dying.client)).rejects.toThrow("offline");

    const candidates = listFlushingInDir(dir, "orgA");
    expect(candidates).toEqual([
      expect.objectContaining({ path: orphan, pid: 4242, lineCount: 2, sampled: false }),
    ]);
    const adopter = recordingClient();
    const summary = await recoverOrphans(candidates, {
      ownerPid: process.pid,
      isAlive: () => false,
      drain: (path, onProgress) => drainFlushingPath(path, adopter.client, { onProgress }),
    });

    expect(summary).toMatchObject({ flushed: 2, quarantined: 0, errors: [] });
    expect(adopter.posts).toEqual([["orphan-c", "orphan-d"]]);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(drainProgressPath(orphan))).toBe(false);
  });

  it("restarts from the first line after an append changes the rotation mid-drain", async () => {
    const moves = Array.from({ length: 1_600 }, (_, index) => move(`grown-${String(index)}`));
    writeJournal(moves);
    const originalSize = statSync(flushing).size;
    const late = move("late-append");
    const failing = recordingClient((_batch, call) => {
      if (call === 1) {
        // A hook that opened the journal just before its rename appends here.
        appendMoveToPath(flushing, late);
      }
      return call === 3 ? new Error("offline") : undefined;
    });

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(readCheckpoint()).toMatchObject({
      offset: journalBytes(moves.slice(0, 1_000)),
      size: originalSize,
    });
    expect(statSync(flushing).size).toBeGreaterThan(originalSize);

    const healthy = recordingClient();
    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 1_601,
      quarantined: 0,
    });
    // The checkpoint no longer describes these bytes, so nothing is skipped.
    expect(healthy.posts.flat()).toEqual([...ids(moves), "late-append"]);
    expect(existsSync(flushing)).toBe(false);
  });

  it("posts a full batch at once, before a later invalid line whose quarantine fails", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const moves = Array.from({ length: 500 }, (_, index) => move(`full-${String(index)}`));
    writeJournal(moves);
    writeFileSync(flushing, invalidLine(), { flag: "a" });
    // Block creation of the hardened dead-letter directory.
    writeFileSync(deadLetterDirectoryForRotation(flushing), "not a directory");
    const first = recordingClient();

    await expect(drainFlushingPath(flushing, first.client)).rejects.toThrow();
    expect(first.posts).toEqual([ids(moves)]);
    expect(readCheckpoint()).toEqual(checkpointAt(journalBytes(moves)));

    // Once the dead letter can be written, the next sweep resumes past the
    // delivered batch and only quarantines the invalid line.
    rmSync(deadLetterDirectoryForRotation(flushing));
    const resumed = recordingClient();
    await expect(drainFlushingPath(flushing, resumed.client)).resolves.toEqual({
      flushed: 0,
      quarantined: 1,
    });
    expect(resumed.posts).toEqual([]);
    expect(existsSync(flushing)).toBe(false);
  });

  it("checkpoints past a run of invalid lines with no move pending before them", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const run = [invalidLine(), Buffer.from("not json\r\n", "utf8")];
    writeFileSync(flushing, Buffer.concat(run));
    appendMoveToPath(flushing, move("after-run"));
    const failing = recordingClient(() => new Error("offline"));

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(readCheckpoint()).toEqual(checkpointAt(run[0].length + run[1].length));
    expect(rawDeadLetters()).toHaveLength(2);

    mocks.syncDirectory.mockClear();
    const healthy = recordingClient();
    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 1,
      quarantined: 0,
    });
    expect(healthy.posts).toEqual([["after-run"]]);
    // The resumed sweep never re-quarantines the run.
    expect(mocks.syncDirectory).not.toHaveBeenCalled();
  });

  it("never checkpoints past an invalid line while a move before it is pending", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const acknowledged = Array.from({ length: 500 }, (_, index) => move(`held-${String(index)}`));
    writeJournal(acknowledged);
    appendMoveToPath(flushing, move("held-p1"));
    writeFileSync(flushing, invalidLine(), { flag: "a" });
    appendMoveToPath(flushing, move("held-p2"));
    const failing = recordingClient((batch) =>
      batch.some((item) => item.moveId === "held-p1") ? new Error("offline") : undefined,
    );

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(failing.posts).toEqual([ids(acknowledged), ["held-p1", "held-p2"]]);
    // The invalid line is durably quarantined, but p1 before it was never
    // acknowledged, so the checkpoint stays at the last acknowledged batch.
    expect(readCheckpoint()).toEqual(checkpointAt(journalBytes(acknowledged)));
    expect(rawDeadLetters()).toHaveLength(1);

    const healthy = recordingClient();
    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 2,
      quarantined: 1,
    });
    expect(healthy.posts).toEqual([["held-p1", "held-p2"]]);
    expect(rawDeadLetters()).toHaveLength(1);
    expect(existsSync(flushing)).toBe(false);
  });

  it("checkpoints multi-byte UTF-8 lines at exact byte boundaries", async () => {
    // é, CJK, and emoji each take more UTF-8 bytes than UTF-16 code units, so
    // an offset counted in characters would land inside an earlier line.
    const moves = Array.from({ length: 600 }, (_, index) => ({
      ...move(`utf8-${String(index)}`),
      payload: { text: `café ${String(index)} 決定事項 🚀🧭` },
    }));
    const lines: Buffer[] = [];
    const ends: number[] = [];
    let written = 0;
    for (const [index, item] of moves.entries()) {
      const terminator = index % 2 === 0 ? "\r\n" : "\n";
      const line = Buffer.from(`${JSON.stringify(item)}${terminator}`, "utf8");
      lines.push(line);
      written += line.length;
      ends.push(written);
      if (index % 7 === 0) {
        const blank = Buffer.from(terminator, "utf8");
        lines.push(blank);
        written += blank.length;
      }
    }
    const source = Buffer.concat(lines);
    writeFileSync(flushing, source);
    const failing = recordingClient((_batch, call) =>
      call === 2 ? new Error("offline") : undefined,
    );

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(failing.posts.map((batch) => batch.length)).toEqual([500, 100]);
    const { offset } = readCheckpoint();
    // Exactly past the 500th move's line terminator, before the blank line.
    expect(offset).toBe(ends[499]);
    expect(source[offset - 1]).toBe(0x0a);
    expect(readCheckpoint()).toEqual(checkpointAt(ends[499]));

    const healthy = recordingClient();
    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 100,
      quarantined: 0,
    });
    expect(healthy.posts.flat()).toEqual(ids(moves.slice(500)));
    expect(existsSync(deadLetterDirectoryForRotation(flushing))).toBe(false);
    expect(existsSync(flushing)).toBe(false);
  });

  it.each([
    [
      "an invalid journal line",
      () => {
        writeFileSync(flushing, invalidLine());
        appendMoveToPath(flushing, move("after-invalid"));
        return invalidLine().length;
      },
    ],
    [
      "a rejected move",
      () => {
        writeJournal([move("poison"), move("after-poison")]);
        return journalBytes([move("poison")]);
      },
    ],
  ])("syncs %s's dead letter before the checkpoint that passes it", async (_label, setup) => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const quarantinedThrough = setup();
    const failing = recordingClient((batch) =>
      batch.some((item) => item.moveId === "poison") ? invalidMove() : new Error("offline"),
    );

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(readCheckpoint()).toEqual(checkpointAt(quarantinedThrough));
    const deadLetterSync = mocks.syncDirectory.mock.calls.findIndex(
      ([path]) => path === deadLetterDirectoryForRotation(flushing),
    );
    const checkpointWrite = mocks.atomicWriteFile.mock.calls.findIndex(
      ([target]) => target === drainProgressPath(flushing),
    );
    expect(deadLetterSync).toBeGreaterThanOrEqual(0);
    expect(checkpointWrite).toBeGreaterThanOrEqual(0);
    expect(mocks.syncDirectory.mock.invocationCallOrder[deadLetterSync]).toBeLessThan(
      mocks.atomicWriteFile.mock.invocationCallOrder[checkpointWrite],
    );
  });

  it("writes no checkpoint for a one-batch drain or for a drain's final slice", async () => {
    writeJournal([move("only-a"), move("only-b")]);
    await expect(drainFlushingPath(flushing, recordingClient().client)).resolves.toEqual({
      flushed: 2,
      quarantined: 0,
    });
    expect(mocks.atomicWriteFile).not.toHaveBeenCalled();

    const moves = Array.from({ length: 1_000 }, (_, index) => move(`final-${String(index)}`));
    writeJournal(moves);
    await expect(drainFlushingPath(flushing, recordingClient().client)).resolves.toEqual({
      flushed: 1_000,
      quarantined: 0,
    });
    // Only the first batch is checkpointed; the unlink follows the second.
    expect(checkpointWrites()).toEqual([journalBytes(moves.slice(0, 500))]);
    expect(existsSync(drainProgressDirectory(flushing))).toBe(false);
  });

  it("reports every retired slice as it happens, before a later failure", async () => {
    vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    writeFileSync(flushing, invalidLine());
    const moves = Array.from({ length: 1_200 }, (_, index) => move(`progress-${String(index)}`));
    writeJournal(moves);
    const failing = recordingClient((_batch, call) =>
      call === 3 ? new Error("offline") : undefined,
    );
    const deltas: DrainCounts[] = [];

    await expect(
      drainFlushingPath(flushing, failing.client, { onProgress: (delta) => deltas.push(delta) }),
    ).rejects.toThrow("offline");
    expect(deltas).toEqual([
      { flushed: 0, quarantined: 1 },
      { flushed: 500, quarantined: 0 },
      { flushed: 500, quarantined: 0 },
    ]);
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
      pendingBytes: 0,
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

  it("credits a failed orphan drain with the slices it retired before failing", async () => {
    const offline = new Error("offline");
    const result = await recoverOrphans(
      [
        flushing({ bucket: "orgA", path: "/a", pid: 4242 }),
        flushing({ bucket: "orgB", path: "/b", pid: 4242 }),
      ],
      {
        now,
        isAlive: dead,
        drain: (path, onProgress) => {
          if (path === "/b") {
            return Promise.resolve({ flushed: 3, quarantined: 0 });
          }
          onProgress({ flushed: 500, quarantined: 0 });
          onProgress({ flushed: 0, quarantined: 1 });
          return Promise.reject(offline);
        },
      },
    );

    expect(result).toMatchObject({ flushed: 503, quarantined: 1 });
    // The drain's own error is kept, not replaced.
    expect(result.errors).toEqual([offline]);
    expect(result.failedBuckets).toEqual(new Set(["orgA"]));
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
