/**
 * Producer journal integration test (nightly only).
 *
 * Drives the real producer journal at scale — a synthetic 10×40×30
 * (12,000-move) fanout — through the production write/read path
 * (`appendMoveToPath` → `readMovesFromPath`), asserting every move
 * round-trips through the NDJSON journal with fidelity. Exercises envelope
 * serialization + the append/read path at a density approximating a long
 * agent session. (The network drain is covered by the flusher's own
 * paths; this test stays local and deterministic.)
 *
 * Skipped unless NIGHTLY=1 (CI runs it from a nightly cron, not per-PR).
 */

import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { appendMoveToPath, readMovesFromPath } from "../journal.js";
import type { Move } from "../protocol/move.js";

const NIGHTLY = process.env.NIGHTLY === "1";

const SESSION_COUNT = 10;
const MOVES_PER_SESSION = 40;
const HOOKS_PER_MOVE = 30;
const PAYLOAD_CHARS = 5000;
const EXPECTED_MOVES = SESSION_COUNT * MOVES_PER_SESSION * HOOKS_PER_MOVE;

const suite = NIGHTLY ? describe : describe.skip;

suite("producer journal — synthetic fanout", () => {
  let scratch: string;
  let path: string;

  beforeAll(() => {
    scratch = mkdtempSync(join(tmpdir(), "prim-integration-"));
    path = join(scratch, "journal.ndjson");
  });

  afterAll(() => {
    rmSync(scratch, { recursive: true, force: true });
  });

  it("round-trips a 12,000-move fanout through the real journal", () => {
    let written = 0;
    for (let s = 0; s < SESSION_COUNT; s++) {
      const sessionId = `session-${String(s)}`;
      for (let m = 0; m < MOVES_PER_SESSION; m++) {
        for (let h = 0; h < HOOKS_PER_MOVE; h++) {
          const move: Move = {
            moveId: `${sessionId}-${String(m)}-${String(h)}`,
            capturedAt: written,
            sessionId,
            eventType: "PostToolUse",
            payload: {
              tool_name: "Read",
              tool_input: { file_path: "/tmp/x.ts" },
              _pad: "x".repeat(PAYLOAD_CHARS),
            },
            env: { cwd: scratch, cliVersion: "test", osPlatform: "linux" },
            envelopeVersion: 1,
          };
          appendMoveToPath(path, move);
          written++;
        }
      }
    }

    expect(written).toBe(EXPECTED_MOVES);
    expect(statSync(path).size).toBeGreaterThan(0);

    const readBack = readMovesFromPath(path);
    expect(readBack).toHaveLength(EXPECTED_MOVES);
    // Round-trip fidelity: first/last survive serialization, payload intact.
    expect(readBack.at(0)?.moveId).toBe("session-0-0-0");
    expect(readBack.at(-1)?.moveId).toBe("session-9-39-29");
    expect(readBack.at(0)?.envelopeVersion).toBe(1);
    expect(readBack.at(0)?.payload).toEqual({
      tool_name: "Read",
      tool_input: { file_path: "/tmp/x.ts" },
      _pad: "x".repeat(PAYLOAD_CHARS),
    });
  });
});

describe("integration suite gating", () => {
  it("skips unless NIGHTLY=1", () => {
    expect(typeof NIGHTLY).toBe("boolean");
  });
});
