/**
 * Cascade ASCII renderer — pure helper coverage.
 *
 * Tests the layout produced by `renderCascade` against the real
 * `CascadeResult` shape the merged server emits. Doesn't pin the exact
 * ASCII layout byte-for-byte — it exercises the discrete render branches:
 * empty downstream, populated downstream + overflow, every trigger kind
 * (including `invalidation`), the rich trigger line (`authorName` +
 * `reason`, the fields that replaced the never-emitted `narrative`), the
 * top-level `truncated` blast-radius warning, and missing upstream refs.
 */

import { describe, expect, it } from "vitest";
import { renderCascade } from "./cascade-renderer.js";
import type { CascadeNode, CascadeResult, CascadeTrigger } from "./cascade.js";

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

function triggerFixture(overrides: Partial<CascadeTrigger> = {}): CascadeTrigger {
  return {
    type: "file_edit",
    file: undefined,
    contextName: undefined,
    flaggedAt: Date.UTC(2026, 5, 7, 14, 32, 0),
    authorName: undefined,
    reason: undefined,
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
    truncated: false,
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
        trigger: triggerFixture({
          type: "file_edit",
          file: "src/auth/config.ts",
        }),
      }),
    );
    expect(out).toContain("[auth.spec]");
    expect(out).toContain("[src/auth/config.ts *]");
    expect(out).toContain("refs (just edited)");
  });

  it("does not leak a file token into the knowledge row when contexts fill the inline cap", () => {
    const contexts = Array.from({ length: 12 }, (_, i) => ({
      id: `k${String(i)}`,
      name: `ctx-${String(i)}`,
    }));
    const out = renderCascade(
      baseResult({
        upstream: { files: ["src/should-not-appear.ts", "src/also-hidden.ts"], contexts },
      }),
    );
    expect(out).not.toContain("should-not-appear");
    expect(out).not.toContain("also-hidden");
    expect(out).toContain("more)");
  });

  it("collapses dependents above the inline limit into '+ N more'", () => {
    const dependents = Array.from({ length: 8 }, (_, i) =>
      nodeFixture({ id: `dep_${String(i)}`, intent: `Dependent ${String(i)}` }),
    );
    const out = renderCascade(baseResult({ downstream: dependents, fanOut: dependents.length }));
    expect(out).toContain("8 affected:");
    expect(out).toContain("+ 3 more");
  });

  it("emits the supersession trigger headline when present", () => {
    const out = renderCascade(
      baseResult({
        trigger: triggerFixture({ type: "supersession" }),
      }),
    );
    expect(out).toContain("an upstream decision was superseded");
  });

  it("emits the invalidation trigger headline when present", () => {
    const out = renderCascade(
      baseResult({
        trigger: triggerFixture({ type: "invalidation" }),
      }),
    );
    expect(out).toContain("an upstream decision was invalidated");
  });

  it("surfaces the trigger author and reason on the rich line", () => {
    const out = renderCascade(
      baseResult({
        trigger: triggerFixture({
          type: "file_edit",
          file: "src/auth/config.ts",
          authorName: "Riley",
          reason: "edit invalidates the Redis latency assumption",
        }),
      }),
    );
    expect(out).toContain("by Riley");
    expect(out).toContain("reason: edit invalidates the Redis latency assumption");
  });

  it("omits the author and reason lines when the server projects neither", () => {
    const out = renderCascade(
      baseResult({
        trigger: triggerFixture({ type: "supersession" }),
      }),
    );
    expect(out).not.toContain("\n  by ");
    expect(out).not.toContain("reason:");
  });

  it("warns when the blast radius is truncated", () => {
    const out = renderCascade(baseResult({ truncated: true, fanOut: 5 }));
    expect(out).toContain("blast radius truncated");
  });

  it("does not warn about truncation when the subgraph is complete", () => {
    const out = renderCascade(baseResult({ truncated: false }));
    expect(out).not.toContain("blast radius truncated");
  });

  it("emits the no-edges-yet impact suffix when downstream is empty", () => {
    const out = renderCascade(baseResult());
    expect(out).toContain("impact: 0 decision(s) need review (no edges yet).");
  });
});
