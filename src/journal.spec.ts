import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeDrainCheckpoint } from "./drain-progress.js";
import {
  JOURNAL_DIR,
  JOURNAL_STATS_SAMPLE_BYTES,
  appendMoveToPath,
  envSlug,
  journalPath,
  listFlushingInDir,
  readMovesFromPath,
  sampleJournalFile,
} from "./journal.js";
import type { Move } from "./protocol/move.js";

function sampleMove(eventType: string, capturedAt = 1): Move {
  return {
    moveId: `m-${eventType}`,
    capturedAt,
    sessionId: "s",
    eventType,
    payload: { ok: true },
    env: { cwd: "/repo", cliVersion: "x", osPlatform: "darwin" },
    envelopeVersion: 1,
  };
}

function lineBytes(...moves: Move[]): number {
  return moves.reduce((bytes, move) => bytes + Buffer.byteLength(`${JSON.stringify(move)}\n`), 0);
}

describe("journal", () => {
  let dir: string;
  let path: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-journal-"));
    path = join(dir, "nested", "journal.ndjson");
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("appends NDJSON lines and round-trips through readMovesFromPath", () => {
    appendMoveToPath(path, sampleMove("PreToolUse"));
    appendMoveToPath(path, sampleMove("PostToolUse"));
    const moves = readMovesFromPath(path);
    expect(moves.map((m) => m.eventType)).toEqual(["PreToolUse", "PostToolUse"]);
  });

  it("creates the journal file mode 0600 (raw payloads are secret-bearing)", () => {
    appendMoveToPath(path, sampleMove("PreToolUse"));
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("skips malformed lines rather than aborting the drain", () => {
    appendMoveToPath(path, sampleMove("PreToolUse"));
    writeFileSync(path, "not json\n", { flag: "a" });
    appendMoveToPath(path, sampleMove("Stop"));
    const moves = readMovesFromPath(path);
    expect(moves.map((m) => m.eventType)).toEqual(["PreToolUse", "Stop"]);
  });

  it("bounds health sampling regardless of journal size", () => {
    const moves = Array.from({ length: 2_000 }, (_, index) =>
      sampleMove(`PostToolUse-${String(index)}`, index + 1),
    );
    const large = join(dir, "large.ndjson");
    writeFileSync(large, moves.map((move) => `${JSON.stringify(move)}\n`).join(""));

    const sample = sampleJournalFile(large, JOURNAL_STATS_SAMPLE_BYTES);
    expect(sample.sampled).toBe(true);
    expect(sample.sampledBytes).toBe(JOURNAL_STATS_SAMPLE_BYTES);
    expect(sample.lineCount).toBeGreaterThan(0);
    expect(sample.lineCount).toBeLessThan(moves.length);
    expect(sample.oldestCapturedAt).toBe(1);
  });
});

describe("listFlushingInDir", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-flushing-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function writeFlushing(name: string, ...moves: Move[]): void {
    writeFileSync(join(dir, name), moves.map((m) => `${JSON.stringify(m)}\n`).join(""));
  }

  it("enumerates a .flushing file and parses its owning pid", () => {
    writeFlushing(
      "journal.ndjson.flushing.1700000000000.4242",
      sampleMove("PreToolUse"),
      sampleMove("PostToolUse"),
    );
    const files = listFlushingInDir(dir, "orgA");
    expect(files).toHaveLength(1);
    expect(files[0]).toMatchObject({ bucket: "orgA", pid: 4242, lineCount: 2 });
  });

  it("reports oldest pending age from Move capturedAt, not file mtime", () => {
    writeFlushing(
      "journal.ndjson.flushing.1700000000000.4242",
      sampleMove("PreToolUse", 9_000),
      sampleMove("PostToolUse", 2_000),
    );
    expect(listFlushingInDir(dir, "orgA")[0].oldestCapturedAt).toBe(2_000);
  });

  it("shares one fixed read budget across many rotation files", () => {
    writeFlushing("journal.ndjson.flushing.1.11", sampleMove("PreToolUse", 1));
    writeFlushing("journal.ndjson.flushing.2.12", sampleMove("PostToolUse", 2));

    const files = listFlushingInDir(dir, "orgA", { sampleBytes: 64 });
    expect(files).toHaveLength(2);
    expect(files.reduce((bytes, file) => bytes + file.sampledBytes, 0)).toBeLessThanOrEqual(64);
    expect(files.every((file) => file.sampled)).toBe(true);
  });

  it("treats the legacy pid-less variant as pid undefined", () => {
    writeFlushing("journal.ndjson.flushing.1700000000000", sampleMove("Stop"));
    const files = listFlushingInDir(dir, "_legacy");
    expect(files).toHaveLength(1);
    expect(files[0].pid).toBeUndefined();
    expect(files[0].lineCount).toBe(1);
  });

  it.each(["0", String(Number.MAX_SAFE_INTEGER + 1)])(
    "treats invalid rotation pid %s as pid-less",
    (pid) => {
      writeFlushing(`journal.ndjson.flushing.1700000000000.${pid}`, sampleMove("Stop"));

      expect(listFlushingInDir(dir, "_legacy")[0]?.pid).toBeUndefined();
    },
  );

  it("ignores the live journal and unrelated files", () => {
    appendMoveToPath(join(dir, "journal.ndjson"), sampleMove("PreToolUse"));
    writeFileSync(join(dir, "notes.txt"), "hello\n");
    expect(listFlushingInDir(dir, "orgA")).toEqual([]);
  });

  it("returns [] for a missing directory", () => {
    expect(listFlushingInDir(join(dir, "absent"), "orgA")).toEqual([]);
  });

  it("samples a rotation from its drain checkpoint and never lists the checkpoint", () => {
    const name = "journal.ndjson.flushing.1700000000000.4242";
    const delivered = sampleMove("PreToolUse", 1_000);
    writeFlushing(name, delivered, sampleMove("PostToolUse", 2_000), sampleMove("Stop", 3_000));
    const path = join(dir, name);
    writeDrainCheckpoint(path, { v: 1, offset: lineBytes(delivered), size: statSync(path).size });

    const files = listFlushingInDir(dir, "orgA");
    expect(files).toEqual([
      expect.objectContaining({ path, lineCount: 2, oldestCapturedAt: 2_000, sampled: false }),
    ]);
  });

  it("reports a fully checkpointed rotation as holding nothing undelivered", () => {
    const name = "journal.ndjson.flushing.1700000000000.4242";
    writeFlushing(name, sampleMove("PreToolUse", 1_000));
    const path = join(dir, name);
    const size = statSync(path).size;
    writeDrainCheckpoint(path, { v: 1, offset: size, size });

    expect(listFlushingInDir(dir, "orgA")).toEqual([
      expect.objectContaining({ lineCount: 0, oldestCapturedAt: undefined, sampled: false }),
    ]);
  });

  it("keeps the bounded-sample lower bound when sampling from a checkpoint", () => {
    const moves = Array.from({ length: 2_000 }, (_, index) =>
      sampleMove(`PostToolUse-${String(index)}`, index + 1),
    );
    const path = join(dir, "journal.ndjson.flushing.1.11");
    writeFlushing("journal.ndjson.flushing.1.11", ...moves);
    writeDrainCheckpoint(path, {
      v: 1,
      offset: lineBytes(...moves.slice(0, 1_000)),
      size: statSync(path).size,
    });

    const sample = sampleJournalFile(path, 1_024, { fromDrainCheckpoint: true });
    expect(sample.sampled).toBe(true);
    expect(sample.sampledBytes).toBe(1_024);
    expect(sample.lineCount).toBeGreaterThan(0);
    expect(sample.lineCount).toBeLessThan(1_000);
    expect(sample.oldestCapturedAt).toBe(1_001);
    // Live journals and checkpoint-unaware callers still sample from byte 0.
    expect(sampleJournalFile(path, 1_024).oldestCapturedAt).toBe(1);
  });
});

describe("journal enumeration around drain checkpoints", () => {
  const originalEnv = { ...process.env };
  let configDir: string;

  beforeEach(() => {
    vi.resetModules();
    configDir = mkdtempSync(join(tmpdir(), "prim-journal-progress-"));
    process.env = {
      ...originalEnv,
      PRIM_API_URL: "https://api.example.test",
      PRIM_CONFIG_DIR: configDir,
    };
  });

  afterEach(() => {
    process.env = originalEnv;
    rmSync(configDir, { recursive: true, force: true });
  });

  it("reports pending stats past the delivered prefix and lists no checkpoint", async () => {
    const journal = await import("./journal.js");
    const progress = await import("./drain-progress.js");
    journal.appendMove(sampleMove("Live", 9_000), "org_a");
    const live = journal.journalPath("org_a");
    const rotation = `${live}.flushing.1700000000000.4242`;
    const delivered = sampleMove("Delivered", 1_000);
    for (const move of [delivered, sampleMove("Pending", 5_000), sampleMove("Later", 7_000)]) {
      journal.appendMoveToPath(rotation, move);
    }
    progress.writeDrainCheckpoint(rotation, {
      v: 1,
      offset: lineBytes(delivered),
      size: statSync(rotation).size,
    });
    // A bucket holding only an orphaned checkpoint is not a bucket or rotation.
    const orphan = join(dirname(journal.journalPath("org_b")), "journal.ndjson.flushing.1.2");
    progress.writeDrainCheckpoint(orphan, { v: 1, offset: 0, size: 0 });

    expect(journal.listBuckets()).toEqual([{ bucket: "org_a", path: live }]);
    expect(journal.listFlushing().map((file) => file.path)).toEqual([rotation]);
    expect(journal.pendingJournalStats()).toEqual({
      pendingCount: 3,
      oldestPendingAt: 5_000,
      strandedCount: 2,
      strandedFileCount: 1,
      sampled: false,
      strandedSampled: false,
    });

    journal.sweepOrphanedDrainProgress();
    expect(existsSync(progress.drainProgressPath(orphan))).toBe(false);
    expect(existsSync(progress.drainProgressPath(rotation))).toBe(true);
  });
});

describe("envSlug", () => {
  it("derives a readable, fs-safe slug from the API base URL", () => {
    expect(envSlug("https://api.getprimitive.ai")).toBe("api.getprimitive.ai");
    expect(envSlug("https://ceaseless-lemur-432.convex.site")).toBe(
      "ceaseless-lemur-432.convex.site",
    );
  });

  it("gives different deployments different slugs, and is stable for one", () => {
    expect(envSlug("https://api.getprimitive.ai")).not.toBe(
      envSlug("https://ceaseless-lemur-432.convex.site"),
    );
    expect(envSlug("https://api.getprimitive.ai/")).toBe(envSlug("https://api.getprimitive.ai"));
  });

  it("sanitizes path-unsafe characters and never yields an empty segment", () => {
    expect(envSlug("https://host.example/x?y=z")).toBe("host.example_x_y_z");
    expect(envSlug("https://")).toBe("default");
  });

  it("rejects the dot-only segments that would escape or collapse JOURNAL_DIR", () => {
    // join(JOURNAL_DIR, "..") would escape the moves tree; join(JOURNAL_DIR,
    // ".") would collapse every deployment onto the unpartitioned root. Both
    // must fall back to a literal partition, never a traversal segment.
    expect(envSlug("https://..")).toBe("default");
    expect(envSlug("https://.")).toBe("default");
    expect(envSlug("..")).toBe("default");
    expect(envSlug("http://.")).toBe("default");
  });
});

describe("journalPath bucket safety", () => {
  const prior = process.env.PRIM_API_URL;
  beforeEach(() => {
    process.env.PRIM_API_URL = "https://example.test";
  });
  afterEach(() => {
    if (prior === undefined) {
      process.env.PRIM_API_URL = undefined;
    } else {
      process.env.PRIM_API_URL = prior;
    }
  });

  it("routes an unsafe orgId to the unbound bucket, never outside JOURNAL_DIR", () => {
    const unbound = journalPath(undefined);
    expect(journalPath("../../../../tmp/evil")).toBe(unbound);
    expect(journalPath("..")).toBe(unbound);
    expect(journalPath("org/abc")).toBe(unbound);
    expect(journalPath("_legacy")).toBe(unbound);
    expect(journalPath("../../etc").startsWith(JOURNAL_DIR)).toBe(true);
  });

  it("keeps a well-formed org id as its own bucket, under the env partition", () => {
    expect(journalPath("jd7k2p9x")).toBe(
      join(JOURNAL_DIR, "example.test", "jd7k2p9x", "journal.ndjson"),
    );
  });

  it("partitions by deployment — the same org under two envs gets two buckets", () => {
    process.env.PRIM_API_URL = "https://api.getprimitive.ai";
    const prod = journalPath("jd7k2p9x");
    process.env.PRIM_API_URL = "https://ceaseless-lemur-432.convex.site";
    const staging = journalPath("jd7k2p9x");
    expect(prod).not.toBe(staging);
    expect(prod).toContain("api.getprimitive.ai");
    expect(staging).toContain("ceaseless-lemur-432.convex.site");
  });
});
