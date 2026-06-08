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
import { renderCascade, softWrap } from "./cascade-renderer.js";
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

  it("renders area chips on each dependent line", () => {
    const dependents = [
      nodeFixture({ id: "d1", intent: "Logout flow", area: "auth" }),
      nodeFixture({ id: "d2", intent: "Audit logging", area: "data" }),
      nodeFixture({ id: "d3", intent: "Cookies", area: undefined }),
    ];
    const out = renderCascade(baseResult({ downstream: dependents, fanOut: 3 }));
    expect(out).toContain("• [auth]  Logout flow");
    expect(out).toContain("• [data]  Audit logging");
    expect(out).toContain("• [--]  Cookies");
  });

  it("appends the cross-area tally on impact when parent area differs from children", () => {
    const dependents = [
      nodeFixture({ id: "d1", area: "auth" }),
      nodeFixture({ id: "d2", area: "auth" }),
      nodeFixture({ id: "d3", area: "mobile" }),
      nodeFixture({ id: "d4", area: "data" }),
    ];
    const out = renderCascade(
      baseResult({
        decision: nodeFixture({
          id: "qx7c6ffja2v5d6jdmja4qmdt81886rvc",
          shortId: "14c2038c",
          intent: "Use Redis for the verification cache",
          area: "infra",
          authorName: "Taylor",
        }),
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
    const out = renderCascade(
      baseResult({
        decision: nodeFixture({
          id: "qx7c6ffja2v5d6jdmja4qmdt81886rvc",
          shortId: "14c2038c",
          intent: "Use Redis for the verification cache",
          area: "auth",
          authorName: "Taylor",
        }),
        downstream: dependents,
        fanOut: 2,
      }),
    );
    expect(out).toContain("impact: 2 decision(s) need review.");
    expect(out).not.toContain("cross-area dependency");
  });

  it("derives cross-area tally from non-dominant areas when parent area is undefined", () => {
    const dependents = [
      nodeFixture({ id: "d1", area: "auth" }),
      nodeFixture({ id: "d2", area: "auth" }),
      nodeFixture({ id: "d3", area: "auth" }),
      nodeFixture({ id: "d4", area: "mobile" }),
    ];
    // Decision area defaults to undefined via nodeFixture; the non-dominant
    // count is 1 (mobile, while auth is dominant with 3).
    const out = renderCascade(baseResult({ downstream: dependents, fanOut: 4 }));
    expect(out).toContain("impact: 4 decision(s) need review · 1 cross-area dependency.");
  });

  it("renders the rich trigger narrative with author + rationale shift when present", () => {
    const out = renderCascade(
      baseResult({
        trigger: {
          type: "file_edit",
          file: "mobile-session.spec",
          contextName: undefined,
          flaggedAt: Date.UTC(2026, 5, 8, 14, 32, 0),
          authorName: "Maya",
          narrative:
            'rationale "iOS offline reauth" shifted; the implicit assumption behind 7-day refresh changes',
        },
      }),
    );
    // The long trigger line may soft-wrap across multiple lines on a
    // narrow terminal — strip the wrap indents and validate the
    // concatenated content. This keeps the assertion stable across
    // terminal-width changes.
    const triggerSection = out
      .split("\n")
      .slice(out.split("\n").findIndex((l) => l.startsWith("trigger:")))
      .join(" ")
      .replace(/\s+/g, " ");
    expect(triggerSection).toContain("trigger: Maya edited mobile-session.spec");
    expect(triggerSection).toContain(
      'rationale "iOS offline reauth" shifted; the implicit assumption behind 7-day refresh changes',
    );
  });

  it("leads with the author name in the file_edit clause when known", () => {
    const out = renderCascade(
      baseResult({
        trigger: {
          type: "file_edit",
          file: "convex/auth/config.ts",
          contextName: undefined,
          flaggedAt: Date.UTC(2026, 5, 8, 14, 30, 0),
          authorName: "Taylor",
        },
      }),
    );
    expect(out).toContain(
      "trigger: Taylor edited convex/auth/config.ts; cascade fired at 2026-06-08.",
    );
  });

  it("falls back to the impersonal file form when no author is known", () => {
    const out = renderCascade(
      baseResult({
        trigger: {
          type: "file_edit",
          file: "convex/auth/config.ts",
          contextName: undefined,
          flaggedAt: Date.UTC(2026, 5, 8, 14, 30, 0),
        },
      }),
    );
    expect(out).toContain("trigger: file 'convex/auth/config.ts' was edited;");
  });

  it("leads with the author name in the context_edit clause when known", () => {
    const out = renderCascade(
      baseResult({
        trigger: {
          type: "context_edit",
          file: undefined,
          contextName: "mobile-session.spec",
          flaggedAt: Date.UTC(2026, 5, 8, 14, 30, 0),
          authorName: "Jamal",
        },
      }),
    );
    expect(out).toContain(
      "trigger: Jamal edited mobile-session.spec; cascade fired at 2026-06-08.",
    );
  });
});

describe("softWrap", () => {
  it("returns the line unchanged when it fits inside the width", () => {
    expect(softWrap("short line", { width: 80 })).toEqual(["short line"]);
  });

  it("wraps a long line on whitespace boundaries with the continuation indent applied", () => {
    const longLine =
      "trigger: Maya edited mobile-session.spec — rationale shifted; the implicit assumption changes.";
    const out = softWrap(longLine, { width: 50, indent: "         " });
    expect(out.length).toBeGreaterThan(1);
    // First line keeps its raw prefix; continuation lines pick up the indent.
    expect(out[0].startsWith("trigger:")).toBe(true);
    expect(out[1].startsWith("         ")).toBe(true);
    // Every line stays within the requested width.
    for (const line of out) {
      expect(line.length).toBeLessThanOrEqual(60);
    }
  });

  it("falls through with a long single word that exceeds the width (no hard-break)", () => {
    const longPath = "convex/some/very/deep/nested/test-file-verify-1.ts";
    const out = softWrap(longPath, { width: 20 });
    expect(out).toEqual([longPath]);
  });
});
