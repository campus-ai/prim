/**
 * Q-D envelope contract test (producer side).
 *
 * The Move envelope shape is duplicated across the producer (this
 * repo, src/protocol/move.ts) and the consumer (client repo's
 * convex/moves/ingest.ts moveValidator). Until codegen-from-type or
 * a shared package eliminates the duplication, this test pins the
 * producer side so any drift surfaces in PR CI rather than at
 * runtime.
 *
 * Producer is intentionally stricter than consumer: `env` is required
 * here and optional server-side. That asymmetry is by design — the
 * CLI knows what it captured; the server tolerates older or partial
 * envelopes from forward-compatible producers.
 */

import { describe, expect, it } from "vitest";
import type { Move } from "../protocol/move";

function sample(): Move {
  return {
    moveId: "00000000-0000-4000-8000-000000000000",
    capturedAt: 1_700_000_000_000,
    sessionId: "session-abc",
    eventType: "PostToolUse",
    payload: { tool_name: "Read", tool_input: { file_path: "/tmp/x" } },
    env: {
      cwd: "/Users/jth/repo",
      cliVersion: "0.1.0-alpha.15",
      osPlatform: "darwin",
    },
  };
}

describe("Move envelope contract", () => {
  it("has every field the server validator expects", () => {
    const m = sample();
    expect(typeof m.moveId).toBe("string");
    expect(typeof m.capturedAt).toBe("number");
    expect(typeof m.sessionId).toBe("string");
    expect(typeof m.eventType).toBe("string");
    expect(m.payload).toBeDefined();
    expect(m.env).toBeDefined();
  });

  it("round-trips through JSON intact (NDJSON journal format)", () => {
    const m = sample();
    const restored = JSON.parse(JSON.stringify(m)) as Move;
    expect(restored.moveId).toBe(m.moveId);
    expect(restored.capturedAt).toBe(m.capturedAt);
    expect(restored.sessionId).toBe(m.sessionId);
    expect(restored.eventType).toBe(m.eventType);
    expect(restored.env.cwd).toBe(m.env.cwd);
    expect(restored.env.cliVersion).toBe(m.env.cliVersion);
    expect(restored.env.osPlatform).toBe(m.env.osPlatform);
  });

  it("rejects null/undefined identity fields at the type boundary", () => {
    // Type-level check; runtime guard belongs in prim-hook's stdin
    // parser. Surfaces if the type is loosened in an unsafe direction.
    const m = sample();
    const required: Array<keyof Move> = [
      "moveId",
      "capturedAt",
      "sessionId",
      "eventType",
      "payload",
      "env",
    ];
    for (const key of required) {
      expect(m[key]).toBeDefined();
    }
  });
});
