import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { JOURNAL_DIR, appendMoveToPath, journalPath, readMovesFromPath } from "./journal.js";
import type { Move } from "./protocol/move.js";

function sampleMove(eventType: string): Move {
  return {
    moveId: `m-${eventType}`,
    capturedAt: 1,
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
});

describe("journalPath bucket safety", () => {
  it("routes an unsafe orgId to the unbound bucket, never outside JOURNAL_DIR", () => {
    const unbound = journalPath(undefined);
    expect(journalPath("../../../../tmp/evil")).toBe(unbound);
    expect(journalPath("..")).toBe(unbound);
    expect(journalPath("org/abc")).toBe(unbound);
    expect(journalPath("_legacy")).toBe(unbound);
    expect(journalPath("../../etc").startsWith(JOURNAL_DIR)).toBe(true);
  });

  it("keeps a well-formed org id as its own bucket", () => {
    expect(journalPath("jd7k2p9x")).toBe(join(JOURNAL_DIR, "jd7k2p9x", "journal.ndjson"));
  });
});
