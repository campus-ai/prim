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

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { stripAnsi } from "../lib/ansi.js";
import { renderCascade, softWrap } from "./cascade-renderer.js";
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

  it("inlines the fan-out fragment on the decision row when fanOut > 0", () => {
    const out = renderCascade(baseResult({ fanOut: 6 }));
    expect(out).toContain(
      "Taylor · 2026-06-07  ·  6 decision(s) depend on this  ·  low reversibility",
    );
  });

  it("omits the fan-out fragment on the decision row when fanOut is 0", () => {
    const out = renderCascade(baseResult({ fanOut: 0 }));
    expect(out).toContain("Taylor · 2026-06-07  ·  low reversibility");
    expect(out).not.toContain("depend on this");
  });

  it("renders an area chip on each dependent line", () => {
    const dependents = [
      nodeFixture({ id: "d1", intent: "Logout flow", area: "auth" }),
      nodeFixture({ id: "d2", intent: "Audit logging", area: "data" }),
      nodeFixture({ id: "d3", intent: "Cookies", area: undefined }),
    ];
    const out = renderCascade(baseResult({ downstream: dependents, fanOut: 3 }));
    expect(out).toContain("[auth]");
    expect(out).toContain("[data]");
    expect(out).toContain("[--]");
  });

  it("appends the cross-area tally when the parent area differs from its dependents", () => {
    const dependents = [
      nodeFixture({ id: "d1", area: "auth" }),
      nodeFixture({ id: "d2", area: "auth" }),
      nodeFixture({ id: "d3", area: "mobile" }),
      nodeFixture({ id: "d4", area: "data" }),
    ];
    const out = renderCascade(
      baseResult({
        decision: nodeFixture({ area: "infra", authorName: "Taylor" }),
        downstream: dependents,
        fanOut: 4,
      }),
    );
    expect(out).toContain("impact: 4 decision(s) need review · 4 cross-area dependency.");
  });

  it("omits the cross-area tally when all dependents share the parent's area", () => {
    const dependents = [
      nodeFixture({ id: "d1", area: "auth" }),
      nodeFixture({ id: "d2", area: "auth" }),
    ];
    const out = renderCascade(baseResult({ downstream: dependents, fanOut: 2 }));
    expect(out).toContain("impact: 2 decision(s) need review.");
    expect(out).not.toContain("cross-area dependency");
  });

  it("falls back to non-dominant areas for the cross-area tally when the parent area is unknown", () => {
    const dependents = [
      nodeFixture({ id: "d1", area: "auth" }),
      nodeFixture({ id: "d2", area: "auth" }),
      nodeFixture({ id: "d3", area: "auth" }),
      nodeFixture({ id: "d4", area: "mobile" }),
    ];
    // Parent area undefined → the dominant area (auth, 3) is treated as "home"
    // and the 1 non-dominant dependent (mobile) is the cross-area signal.
    const out = renderCascade(
      baseResult({
        decision: nodeFixture({ area: undefined, authorName: "Taylor" }),
        downstream: dependents,
        fanOut: 4,
      }),
    );
    expect(out).toContain("impact: 4 decision(s) need review · 1 cross-area dependency.");
  });
});

describe("softWrap", () => {
  it("returns the line unchanged when it fits inside the width", () => {
    expect(softWrap("short line", { width: 80 })).toEqual(["short line"]);
  });

  it("wraps a long line on whitespace boundaries with the continuation indent applied", () => {
    const longLine =
      "reason: Maya edited mobile-session.spec — the implicit assumption behind 7-day refresh changes.";
    const out = softWrap(longLine, { width: 50, indent: "         " });
    expect(out.length).toBeGreaterThan(1);
    // First line keeps its raw prefix; continuation lines pick up the indent.
    expect(out[0].startsWith("reason:")).toBe(true);
    expect(out[1].startsWith("         ")).toBe(true);
    // Every visible line stays within the requested width.
    for (const line of out) {
      expect(stripAnsi(line).length).toBeLessThanOrEqual(60);
    }
  });

  it("falls through with a long single word that exceeds the width (no hard-break)", () => {
    const longPath = "convex/some/very/deep/nested/test-file-verify-1.ts";
    const out = softWrap(longPath, { width: 20 });
    expect(out).toEqual([longPath]);
  });
});

describe("renderCascade color + soft-wrap", () => {
  const originalIsTTY = process.stderr.isTTY;
  const originalNoColor = process.env.NO_COLOR;

  beforeEach(() => {
    // Force a known-TTY, color-enabled state so the renderer emits ANSI
    // escapes deterministically regardless of how the test runner is wired.
    Object.defineProperty(process.stderr, "isTTY", {
      value: true,
      configurable: true,
    });
    // biome-ignore lint/performance/noDelete: env teardown requires actual removal
    delete process.env.NO_COLOR;
  });

  afterEach(() => {
    Object.defineProperty(process.stderr, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    if (originalNoColor === undefined) {
      // biome-ignore lint/performance/noDelete: env teardown requires actual removal
      delete process.env.NO_COLOR;
    } else {
      process.env.NO_COLOR = originalNoColor;
    }
  });

  it("emits ANSI escapes that strip back to the plain structural output", () => {
    const out = renderCascade(
      baseResult({
        downstream: [nodeFixture({ id: "d1", intent: "Logout flow", area: "auth" })],
        fanOut: 1,
      }),
    );
    // Color codes are present on a TTY.
    expect(out).not.toBe(stripAnsi(out));
    // …and the stripped output still carries the structural tokens.
    const plain = stripAnsi(out);
    expect(plain).toContain("dec_14c2038c");
    expect(plain).toContain("[auth]");
  });

  it("soft-wraps a long trigger reason under a narrow terminal", () => {
    const originalColumns = process.stdout.columns;
    Object.defineProperty(process.stdout, "columns", {
      value: 50,
      configurable: true,
    });
    try {
      const longReason =
        "the edit invalidates the Redis latency assumption that the verification cache leaned on under sustained load";
      const out = renderCascade(
        baseResult({
          trigger: triggerFixture({
            type: "file_edit",
            file: "src/auth/config.ts",
            authorName: "Riley",
            reason: longReason,
          }),
        }),
      );
      const plainLines = stripAnsi(out).split("\n");
      const reasonIdx = plainLines.findIndex((l) => l.trimStart().startsWith("reason:"));
      expect(reasonIdx).toBeGreaterThanOrEqual(0);
      // The reason wrapped onto at least one continuation line carrying the indent.
      expect(plainLines[reasonIdx + 1].startsWith("         ")).toBe(true);
      // Re-joining the wrapped lines recovers the full reason text.
      const stitched = plainLines.slice(reasonIdx).join(" ").replace(/\s+/g, " ");
      expect(stitched).toContain(longReason);
    } finally {
      Object.defineProperty(process.stdout, "columns", {
        value: originalColumns,
        configurable: true,
      });
    }
  });
});
