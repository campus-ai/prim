/**
 * Cascade ASCII renderer — pure helper coverage.
 *
 * Tests the layout produced by `renderCascade` against representative
 * `CascadeResult` shapes the server emits. Doesn't try to match the
 * image-#1 layout byte-for-byte — exercises the discrete render
 * branches: empty downstream, populated downstream + overflow, with
 * and without a trigger narrative, and missing upstream refs.
 */

import { describe, expect, it } from "vitest";
import { renderCascade } from "./cascade-renderer.js";
import type { CascadeNode, CascadeResult } from "./cascade.js";

function nodeFixture(overrides: Partial<CascadeNode> = {}): CascadeNode {
  return {
    id: "qx7node",
    shortId: undefined,
    intent: "Untitled decision",
    area: undefined,
    authorName: "Anonymous",
    classifiedAt: Date.UTC(2026, 5, 7, 14, 30, 0),
    status: "active",
    ...overrides,
  };
}

function baseResult(overrides: Partial<CascadeResult> = {}): CascadeResult {
  return {
    decision: nodeFixture({
      id: "qx7c6ffja2v5d6jdmja4qmdt81886rvc",
      shortId: "14c2038c",
      intent: "Use Redis for the verification cache",
      area: "auth",
      authorName: "Taylor",
    }),
    rationale: "Latency budget is 5ms p95 under load",
    reversibility: "low",
    fanOut: 0,
    upstream: { files: [], contexts: [] },
    downstream: [],
    trigger: null,
    ...overrides,
  };
}

describe("renderCascade", () => {
  it("emits the header with fan-out count and decision identity", () => {
    const out = renderCascade(baseResult({ fanOut: 6 }));
    expect(out).toContain("what this would break · 6 decision(s) · enforcing");
    expect(out).toContain("dec_14c2038c");
    expect(out).toContain("Use Redis for the verification cache");
  });

  it("notes no upstream knowledge when files and contexts are empty", () => {
    const out = renderCascade(baseResult());
    expect(out).toContain("(no upstream knowledge refs)");
  });

  it("renders bracketed knowledge nodes and stars the trigger file", () => {
    const out = renderCascade(
      baseResult({
        upstream: {
          files: ["src/auth/config.ts", "src/cache/redis.ts"],
          contexts: [{ id: "k1", name: "auth.spec" }],
        },
        trigger: {
          type: "file_edit",
          file: "src/auth/config.ts",
          contextName: undefined,
          flaggedAt: Date.UTC(2026, 5, 7, 14, 32, 0),
        },
      }),
    );
    expect(out).toContain("[auth.spec]");
    expect(out).toContain("[src/auth/config.ts *]");
    expect(out).toContain("refs (just edited)");
  });

  it("collapses dependents above the inline limit into '+ N more'", () => {
    const dependents = Array.from({ length: 8 }, (_, i) =>
      nodeFixture({ id: `dep_${String(i)}`, intent: `Dependent ${String(i)}` }),
    );
    const out = renderCascade(baseResult({ downstream: dependents, fanOut: dependents.length }));
    expect(out).toContain("8 affected:");
    expect(out).toContain("+ 3 more");
  });

  it("emits the supersession trigger narrative when present", () => {
    const out = renderCascade(
      baseResult({
        trigger: {
          type: "supersession",
          file: undefined,
          contextName: undefined,
          flaggedAt: Date.UTC(2026, 5, 7, 14, 35, 0),
        },
      }),
    );
    expect(out).toContain("an upstream decision was superseded");
  });

  it("emits the no-edges-yet impact suffix when downstream is empty", () => {
    const out = renderCascade(baseResult());
    expect(out).toContain("impact: 0 decision(s) need review (no edges yet).");
  });
});
