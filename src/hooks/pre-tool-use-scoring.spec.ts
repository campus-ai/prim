/**
 * Pure helper coverage for the prim PreToolUse hook (M3).
 *
 * Tests `aggregateCheckResults`, `buildHookOutput`, `extractFilePaths`,
 * and the env-var readers. The end-to-end stdin → stdout JSON flow
 * is smoked against a synthetic envelope in `pre-tool-use.spec.ts`
 * once that suite exists.
 */

import { describe, expect, it } from "vitest";
import {
  type ConflictCheckResult,
  aggregateCheckResults,
  buildHookOutput,
  demoteForMode,
  extractFilePaths,
  failOpenOutput,
  readDenyReversibility,
  readFanOutThreshold,
  readHookMode,
} from "./pre-tool-use-scoring.js";

function resultFixture(overrides: Partial<ConflictCheckResult> = {}): ConflictCheckResult {
  return {
    verdict: "allow",
    conflicts: [],
    reason: "",
    additionalContext: "",
    ...overrides,
  };
}

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
});

describe("buildHookOutput", () => {
  it("emits deny + reason when the aggregate is deny", () => {
    const out = buildHookOutput("deny", [
      resultFixture({
        verdict: "deny",
        reason: "[primitive] conflict — pausing for review",
      }),
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
      resultFixture({
        verdict: "warn",
        additionalContext: "[primitive] file touched a decision",
      }),
    ]);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.additionalContext).toContain(
      "[primitive] file touched a decision",
    );
  });

  it("emits a bare allow when the aggregate is allow", () => {
    const out = buildHookOutput("allow", [resultFixture()]);
    expect(out.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(out.hookSpecificOutput.permissionDecisionReason).toBeUndefined();
    expect(out.hookSpecificOutput.additionalContext).toBeUndefined();
  });

  it("falls back to a generic reason when deny has no string payload", () => {
    const out = buildHookOutput("deny", [resultFixture({ verdict: "deny", reason: "" })]);
    expect(out.hookSpecificOutput.permissionDecisionReason).toContain("conflict detected");
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
    expect(
      extractFilePaths("Write", {
        file_path: "src/new.ts",
        content: "x",
      }),
    ).toEqual(["src/new.ts"]);
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

describe("readFanOutThreshold", () => {
  it("returns 3 by default", () => {
    expect(readFanOutThreshold({})).toBe(3);
  });

  it("parses a positive integer", () => {
    expect(readFanOutThreshold({ PRIM_HOOK_FANOUT_THRESHOLD: "10" })).toBe(10);
  });

  it("falls back on a malformed value", () => {
    expect(readFanOutThreshold({ PRIM_HOOK_FANOUT_THRESHOLD: "abc" })).toBe(3);
    expect(readFanOutThreshold({ PRIM_HOOK_FANOUT_THRESHOLD: "-5" })).toBe(3);
  });
});

describe("readDenyReversibility", () => {
  it("defaults to low", () => {
    expect(readDenyReversibility({})).toBe("low");
  });

  it("returns high when explicitly set", () => {
    expect(readDenyReversibility({ PRIM_HOOK_DENY_REVERSIBILITY: "high" })).toBe("high");
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
