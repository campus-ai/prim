/**
 * Move envelope contract test (producer side).
 *
 * The Move envelope shape is duplicated across the producer (this repo's
 * src/protocol/move.ts) and the consumer (the Convex ingest validator).
 * Until codegen-from-type or a shared package eliminates the duplication,
 * this test pins the producer side so any drift surfaces in CI rather than
 * at runtime.
 *
 * Producer is intentionally stricter than the consumer: `env` is required
 * here and optional server-side — the CLI knows exactly what it captured,
 * while the server tolerates older or partial envelopes from
 * forward-compatible producers.
 */

import { describe, expect, it } from "vitest";
import {
  AGENT_ENVELOPE_VERSION,
  LEGACY_ENVELOPE_VERSION,
  type Move,
  type MoveV1,
  withAgentProvenance,
} from "../protocol/move";

function sample(): MoveV1 {
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
    envelopeVersion: LEGACY_ENVELOPE_VERSION,
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
    expect(typeof m.envelopeVersion).toBe("number");
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
    expect(restored.envelopeVersion).toBe(m.envelopeVersion);
  });

  it("keeps the required fields non-optional at the type boundary", () => {
    const m = sample();
    const required: Array<keyof Move> = [
      "moveId",
      "capturedAt",
      "sessionId",
      "eventType",
      "payload",
      "env",
      "envelopeVersion",
    ];
    for (const key of required) {
      expect(m[key]).toBeDefined();
    }
  });

  it("carries an optional top-level producer the server validator accepts", () => {
    // Codex moves stamp `producer` at the envelope top level (a sibling of
    // envelopeVersion), matching the backend's optional top-level validator;
    // Claude moves omit it entirely, so the field stays optional on both sides
    // and a Claude envelope serializes with no `producer` key.
    const codex: Move = { ...sample(), producer: "codex" };
    const restored = JSON.parse(JSON.stringify(codex)) as Move;
    expect(restored.producer).toBe("codex");
    expect("producer" in (JSON.parse(JSON.stringify(sample())) as object)).toBe(false);
  });

  it("keeps the V1 wire representation byte-compatible", () => {
    expect(JSON.parse(JSON.stringify(sample()))).toEqual({
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
      envelopeVersion: 1,
    });
  });

  it("upgrades agent moves to V2 with explicit nested provenance", () => {
    const original = sample();
    const upgraded = withAgentProvenance(
      original,
      "claude_code",
      "123e4567-e89b-42d3-a456-426614174000",
    );

    expect(upgraded.envelopeVersion).toBe(AGENT_ENVELOPE_VERSION);
    expect(upgraded.producer).toBe("claude_code");
    expect(upgraded.env.workspaceId).toBe("123e4567-e89b-42d3-a456-426614174000");
    expect(upgraded.env.cwd).toBe(original.env.cwd);
    expect(original.envelopeVersion).toBe(LEGACY_ENVELOPE_VERSION);
    expect("workspaceId" in original.env).toBe(false);
  });

  it("round-trips V2 without moving workspaceId to the closed top level", () => {
    const upgraded = withAgentProvenance(
      sample(),
      "hermes",
      "123e4567-e89b-42d3-a456-426614174000",
    );
    const wire = JSON.parse(JSON.stringify(upgraded)) as Record<string, unknown>;

    expect(wire.envelopeVersion).toBe(2);
    expect(wire.producer).toBe("hermes");
    expect(wire).not.toHaveProperty("workspaceId");
    expect(wire).toHaveProperty("env.workspaceId", "123e4567-e89b-42d3-a456-426614174000");
  });
});
