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

const mocks = vi.hoisted(() => ({ syncDirectory: vi.fn() }));

vi.mock("./lib/atomic-file.js", () => ({ syncDirectory: mocks.syncDirectory }));

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
  drainProgressDirectory,
  drainProgressPath,
  writeDrainCheckpoint,
} from "./drain-progress.js";
import {
  BATCH_MAX_BYTES,
  batchMoves,
  drainFlushingPath as drainOrganizationBoundFlushingPath,
  recoverOrphans,
  selectRecoverable,
  shouldFlushPending,
} from "./flusher.js";
import { IngestAcknowledgementError } from "./ingest-response.js";
import type { CurrentOrganizationBinding } from "./journal-organization.js";
import { type FlushingFile, appendMoveToPath, readMovesFromPath } from "./journal.js";
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
});

describe("flush replay stability", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-flush-"));
    mocks.syncDirectory.mockReset();
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
    const size = statSync(flushing).size;
    const failing = recordingClient((_batch, call) =>
      call === 3 ? new Error("offline") : undefined,
    );

    await expect(drainFlushingPath(flushing, failing.client)).rejects.toThrow("offline");
    expect(failing.posts.map((batch) => batch.length)).toEqual([500, 500, 500]);
    expect(readCheckpoint()).toEqual({ v: 1, offset: journalBytes(moves.slice(0, 1_000)), size });

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
    expect(readCheckpoint()).toEqual({
      v: 1,
      offset: journalBytes(moves.slice(0, 2)),
      size: statSync(flushing).size,
    });

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
    writeDrainCheckpoint(flushing, {
      v: 1,
      offset: journalBytes([move("tail")]),
      size: source.length,
    });
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
    const size = statSync(flushing).size;
    writeDrainCheckpoint(flushing, { v: 1, offset: size, size });
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
    ["wrong-version", (offset: number, size: number) => JSON.stringify({ v: 2, offset, size })],
    [
      "size-mismatched",
      (offset: number, size: number) => JSON.stringify({ v: 1, offset, size: size + 1 }),
    ],
    [
      "out-of-range",
      (_offset: number, size: number) => JSON.stringify({ v: 1, offset: size + 1, size }),
    ],
    ["negative", (_offset: number, size: number) => JSON.stringify({ v: 1, offset: -1, size })],
    [
      "fractional",
      (offset: number, size: number) => JSON.stringify({ v: 1, offset: offset + 0.5, size }),
    ],
  ])("ignores a %s checkpoint and drains from the first line", async (_label, checkpoint) => {
    const moves = [move("from-a"), move("from-b")];
    writeJournal(moves);
    mkdirSync(drainProgressDirectory(flushing));
    writeFileSync(
      drainProgressPath(flushing),
      checkpoint(journalBytes(moves.slice(0, 1)), statSync(flushing).size),
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

  it("still delivers and retires a rotation when progress cannot be recorded", async () => {
    writeJournal([move("no-progress")]);
    // Block creation of the checkpoint directory.
    writeFileSync(drainProgressDirectory(flushing), "not a directory");
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    const healthy = recordingClient();

    await expect(drainFlushingPath(flushing, healthy.client)).resolves.toEqual({
      flushed: 1,
      quarantined: 0,
    });
    expect(existsSync(flushing)).toBe(false);
    expect(stderr.mock.calls.flat().join("")).toContain("could not record drain progress");
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
