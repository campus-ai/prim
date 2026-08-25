import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
