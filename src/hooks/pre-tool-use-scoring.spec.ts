/**
 * Pure helper coverage for the prim PreToolUse hook.
 *
 * Tests path relativization, verdict aggregation, the fail-closed
 * unavailable/truncated handling, the Claude-Code output mapping, file-path
 * extraction, and the env-var readers. The end-to-end stdin → stdout flow is
 * an entrypoint module and is exercised by a live smoke during release.
 */

import { describe, expect, it } from "vitest";
import {
  type ConflictCheckResult,
  aggregateCheckResults,
  anyUnverified,
  buildHermesOutput,
  buildHookOutput,
  demoteForMode,
  extractFilePaths,
  failOpenHermes,
  failOpenOutput,
  parseApplyPatchPaths,
  readHookMode,
  toRepoRelative,
  unverifiedNote,
} from "./pre-tool-use-scoring.js";

function resultFixture(overrides: Partial<ConflictCheckResult> = {}): ConflictCheckResult {
  return {
    verdict: "allow",
    conflicts: [],
    reason: "",
    additionalContext: "",
    truncated: false,
    ...overrides,
  };
}

describe("toRepoRelative", () => {
  it("relativizes an absolute path against the session cwd", () => {
    expect(toRepoRelative("/repo/src/auth/config.ts", "/repo")).toBe("src/auth/config.ts");
  });

  it("passes a relative path through unchanged", () => {
    expect(toRepoRelative("src/auth/config.ts", "/repo")).toBe("src/auth/config.ts");
  });

  it("relativizes an out-of-repo absolute path to a non-matching ../ key", () => {
    expect(toRepoRelative("/elsewhere/x.ts", "/repo")).toBe("../elsewhere/x.ts");
  });
});

describe("aggregateCheckResults", () => {
  it("allows the empty list", () => {
    expect(aggregateCheckResults([])).toBe("allow");
  });

  it("picks deny over ask over warn", () => {
    expect(
      aggregateCheckResults([
        resultFixture({ verdict: "warn" }),
        resultFixture({ verdict: "deny" }),
        resultFixture({ verdict: "ask" }),
      ]),
    ).toBe("deny");
  });

  it("returns ask when nothing escalates to deny", () => {
    expect(
      aggregateCheckResults([
        resultFixture({ verdict: "warn" }),
        resultFixture({ verdict: "ask" }),
      ]),
    ).toBe("ask");
  });

  it("returns allow when every entry is allow", () => {
    expect(aggregateCheckResults([resultFixture(), resultFixture()])).toBe("allow");
  });

  it("does not let an unavailable result escalate severity", () => {
    expect(aggregateCheckResults([resultFixture({ verdict: "unavailable" })])).toBe("allow");
  });

  it("still denies when a deny accompanies an unavailable result", () => {
    expect(
      aggregateCheckResults([
        resultFixture({ verdict: "unavailable" }),
        resultFixture({ verdict: "deny" }),
      ]),
    ).toBe("deny");
  });
});

describe("anyUnverified", () => {
  it("is true for an unavailable result", () => {
    expect(anyUnverified([resultFixture({ verdict: "unavailable" })])).toBe(true);
  });

  it("is true for a truncated result", () => {
    expect(anyUnverified([resultFixture({ truncated: true })])).toBe(true);
  });

  it("is false when every result is verified", () => {
    expect(anyUnverified([resultFixture(), resultFixture({ verdict: "warn" })])).toBe(false);
  });
});

describe("unverifiedNote", () => {
  it("names the org-unbound cause for an unavailable result", () => {
    const note = unverifiedNote([
      resultFixture({ verdict: "unavailable", unavailable: "no organization bound to this token" }),
    ]);
    expect(note).toContain("decision check skipped");
    expect(note).toContain("no organization bound to this token");
  });

  it("names truncation for a partial conflict set", () => {
    expect(unverifiedNote([resultFixture({ truncated: true })])).toContain("truncated");
  });
});

describe("buildHookOutput", () => {
  it("emits deny + reason when the aggregate is deny", () => {
    const out = buildHookOutput("deny", [
      resultFixture({ verdict: "deny", reason: "[primitive] conflict — pausing for review" }),
    ]);
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain(
      "[primitive] conflict — pausing for review",
    );
  });

  it("emits ask + reason when the aggregate is ask", () => {
    const out = buildHookOutput("ask", [
      resultFixture({ verdict: "ask", reason: "please confirm" }),
    ]);
    expect(out.hookSpecificOutput.permissionDecision).toBe("ask");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("please confirm");
  });

  it("emits allow + additionalContext when the aggregate is warn with context", () => {
    const out = buildHookOutput("warn", [
      resultFixture({ verdict: "warn", additionalContext: "[primitive] file touched a decision" }),
    ]);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "[primitive] file touched a decision",
    );
  });

  it("surfaces a not-verified note instead of a bare allow when a result is unavailable", () => {
    const out = buildHookOutput("allow", [
      resultFixture({ verdict: "unavailable", unavailable: "no organization bound to this token" }),
    ]);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.additionalContext).toContain("decision check skipped");
    expect(out.hookSpecificOutput.additionalContext).toContain("no organization bound");
  });

  it("surfaces a partial note instead of a bare allow when a result is truncated", () => {
    const out = buildHookOutput("allow", [resultFixture({ truncated: true })]);
    expect(out.hookSpecificOutput.additionalContext).toContain("truncated");
  });

  it("emits a clean bare allow only when fully verified", () => {
    const out = buildHookOutput("allow", [resultFixture()]);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  it("treats a reconcile-bypass-consumed clean result as an authorized allow", () => {
    const out = buildHookOutput("allow", [
      resultFixture({
        bypassed: [{ decisionId: "d1", shortId: "abcd1234" }],
        reason: "[primitive] reconcile bypass consumed",
      }),
    ]);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  it("falls back to a generic reason when deny has no string payload", () => {
    const out = buildHookOutput("deny", [resultFixture({ verdict: "deny", reason: "" })]);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("conflict detected");
  });

  it("demotes a Codex ask to allow + merged additionalContext (Codex can't ask)", () => {
    const out = buildHookOutput(
      "ask",
      [
        resultFixture({
          verdict: "ask",
          reason: "please confirm",
          additionalContext: "To reconcile, run: prim reconcile dec_ab12cd34",
        }),
      ],
      "codex",
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toContain("please confirm");
    expect(out.hookSpecificOutput.additionalContext).toContain("prim reconcile dec_ab12cd34");
  });

  it("still denies for Codex (Codex honors deny)", () => {
    const out = buildHookOutput(
      "deny",
      [resultFixture({ verdict: "deny", reason: "blocked" })],
      "codex",
    );
    expect(out.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("blocked");
  });
});

describe("extractFilePaths", () => {
  it("returns the file_path from an Edit input", () => {
    expect(
      extractFilePaths("Edit", {
        file_path: "src/auth/config.ts",
        old_string: "a",
        new_string: "b",
      }),
    ).toEqual(["src/auth/config.ts"]);
  });

  it("returns the file_path from a Write input", () => {
    expect(extractFilePaths("Write", { file_path: "src/new.ts", content: "x" })).toEqual([
      "src/new.ts",
    ]);
  });

  it("returns the file_path from a MultiEdit input", () => {
    expect(
      extractFilePaths("MultiEdit", {
        file_path: "src/multi.ts",
        edits: [{ old_string: "a", new_string: "b" }],
      }),
    ).toEqual(["src/multi.ts"]);
  });

  it("returns empty for an unsupported tool", () => {
    expect(extractFilePaths("Bash", { command: "ls" })).toEqual([]);
  });

  it("returns empty for malformed input", () => {
    expect(extractFilePaths("Edit", null)).toEqual([]);
    expect(extractFilePaths("Edit", "not-an-object")).toEqual([]);
  });

  it("returns empty when file_path is missing", () => {
    expect(extractFilePaths("Edit", { old_string: "a" })).toEqual([]);
  });

  it("parses apply_patch paths for Codex (Update / Add / Delete)", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/auth/config.ts",
      "@@",
      "-old",
      "+new",
      "*** Add File: src/auth/new.ts",
      "+content",
      "*** Delete File: src/auth/old.ts",
      "*** End Patch",
    ].join("\n");
    expect(extractFilePaths("apply_patch", { command: patch }, "codex")).toEqual([
      "src/auth/config.ts",
      "src/auth/new.ts",
      "src/auth/old.ts",
    ]);
  });

  it("returns empty for a non-apply_patch Codex tool (fail-open)", () => {
    expect(extractFilePaths("Bash", { command: "ls" }, "codex")).toEqual([]);
  });

  it("returns empty for a malformed Codex apply_patch input", () => {
    expect(extractFilePaths("apply_patch", null, "codex")).toEqual([]);
    expect(extractFilePaths("apply_patch", { command: 42 }, "codex")).toEqual([]);
  });

  it("reads the write_file path for Hermes", () => {
    expect(extractFilePaths("write_file", { path: "src/h.ts", content: "x" }, "hermes")).toEqual([
      "src/h.ts",
    ]);
  });

  it("reads the patch path for a Hermes patch in replace mode (default)", () => {
    expect(
      extractFilePaths("patch", { path: "src/h.ts", old_string: "a", new_string: "b" }, "hermes"),
    ).toEqual(["src/h.ts"]);
    expect(extractFilePaths("patch", { mode: "replace", path: "src/h.ts" }, "hermes")).toEqual([
      "src/h.ts",
    ]);
  });

  it("parses the V4A body for a Hermes patch in patch mode", () => {
    expect(
      extractFilePaths(
        "patch",
        { mode: "patch", patch: "*** Update File: src/a.ts\n*** Add File: src/b.ts" },
        "hermes",
      ),
    ).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("captures both paths of a Hermes patch-mode rename (`*** Move File:`)", () => {
    expect(
      extractFilePaths(
        "patch",
        { mode: "patch", patch: "*** Move File: src/old.ts -> src/new.ts" },
        "hermes",
      ),
    ).toEqual(["src/old.ts", "src/new.ts"]);
  });

  it("returns empty for a non-edit Hermes tool (terminal fail-open)", () => {
    expect(extractFilePaths("terminal", { command: "ls" }, "hermes")).toEqual([]);
  });

  it("returns empty for malformed Hermes input", () => {
    expect(extractFilePaths("write_file", null, "hermes")).toEqual([]);
    expect(extractFilePaths("write_file", { content: "no path" }, "hermes")).toEqual([]);
    expect(extractFilePaths("patch", { mode: "patch", patch: 42 }, "hermes")).toEqual([]);
  });
});

describe("parseApplyPatchPaths", () => {
  it("dedupes repeated paths and trims surrounding whitespace", () => {
    const patch = "*** Update File: a.ts\n*** Update File: a.ts\n*** Add File:  b.ts ";
    expect(parseApplyPatchPaths(patch)).toEqual(["a.ts", "b.ts"]);
  });

  it("returns empty for patch text with no file headers", () => {
    expect(parseApplyPatchPaths("just some\nrandom text")).toEqual([]);
    expect(parseApplyPatchPaths("")).toEqual([]);
  });

  it("handles CRLF line endings without dropping files", () => {
    expect(parseApplyPatchPaths("*** Update File: a.ts\r\n*** Add File: b.ts\r\n")).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("captures both src and dst of a standalone `*** Move File:` rename", () => {
    expect(parseApplyPatchPaths("*** Move File: src/old.ts -> src/new.ts")).toEqual([
      "src/old.ts",
      "src/new.ts",
    ]);
  });
});

describe("readHookMode", () => {
  it("returns off when PRIM_BYPASS=1", () => {
    expect(readHookMode({ PRIM_BYPASS: "1" })).toBe("off");
    expect(readHookMode({ PRIM_BYPASS: "true" })).toBe("off");
  });

  it("returns off when PRIM_HOOK_MODE=off", () => {
    expect(readHookMode({ PRIM_HOOK_MODE: "off" })).toBe("off");
  });

  it("returns warn when PRIM_HOOK_MODE=warn", () => {
    expect(readHookMode({ PRIM_HOOK_MODE: "warn" })).toBe("warn");
  });

  it("defaults to block", () => {
    expect(readHookMode({})).toBe("block");
    expect(readHookMode({ PRIM_HOOK_MODE: "unknown" })).toBe("block");
  });
});

describe("demoteForMode", () => {
  it("returns allow when mode is off regardless of verdict", () => {
    expect(demoteForMode("deny", "off")).toBe("allow");
    expect(demoteForMode("ask", "off")).toBe("allow");
  });

  it("returns warn when mode is warn and verdict is ask/deny", () => {
    expect(demoteForMode("deny", "warn")).toBe("warn");
    expect(demoteForMode("ask", "warn")).toBe("warn");
  });

  it("preserves the verdict when mode is block", () => {
    expect(demoteForMode("deny", "block")).toBe("deny");
    expect(demoteForMode("ask", "block")).toBe("ask");
  });

  it("preserves allow + warn in any mode", () => {
    expect(demoteForMode("allow", "warn")).toBe("allow");
    expect(demoteForMode("warn", "block")).toBe("warn");
  });
});

describe("failOpenOutput", () => {
  it("emits a bare allow", () => {
    const out = failOpenOutput();
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.hookEventName).toBe("PreToolUse");
  });
});

describe("buildHermesOutput", () => {
  it("blocks on deny with the reason as the message", () => {
    const out = buildHermesOutput("deny", [
      resultFixture({ verdict: "deny", reason: "[primitive] conflict — pausing for review" }),
    ]);
    expect(out.action).toBe("block");
    expect(out.message).toContain("[primitive] conflict — pausing for review");
  });

  it("blocks on ask too (no soft tier), carrying the reconcile directive", () => {
    const out = buildHermesOutput("ask", [
      resultFixture({
        verdict: "ask",
        reason: "please confirm",
        additionalContext: "To reconcile, run: prim reconcile dec_ab12cd34",
      }),
    ]);
    expect(out.action).toBe("block");
    expect(out.message).toContain("please confirm");
    expect(out.message).toContain("prim reconcile dec_ab12cd34");
  });

  it("allows (empty object) on warn/allow — no advisory channel at pre_tool_call", () => {
    expect(buildHermesOutput("warn", [resultFixture({ verdict: "warn" })])).toEqual({});
    expect(buildHermesOutput("allow", [resultFixture()])).toEqual({});
  });

  it("allows even when a result is unverified (cannot ride a pre_tool_call allow)", () => {
    expect(buildHermesOutput("allow", [resultFixture({ verdict: "unavailable" })])).toEqual({});
  });

  it("falls back to a generic message when deny has no detail", () => {
    const out = buildHermesOutput("deny", [resultFixture({ verdict: "deny", reason: "" })]);
    expect(out.message).toContain("conflict detected");
  });
});

describe("failOpenHermes", () => {
  it("emits an empty object (no block)", () => {
    expect(failOpenHermes()).toEqual({});
  });
});
