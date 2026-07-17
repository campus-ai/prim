import { describe, expect, it } from "vitest";
import { REAUTH_NOTICE, reauthNoticeOutput } from "./reauth-notice.js";

describe("reauthNoticeOutput", () => {
  it("routes the notice to Codex developer context (no statusline)", () => {
    expect(reauthNoticeOutput("codex")).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: REAUTH_NOTICE,
      },
    });
  });

  it("routes the notice to Claude Code's systemMessage", () => {
    expect(reauthNoticeOutput("claude_code")).toEqual({ systemMessage: REAUTH_NOTICE });
  });

  it("returns nothing for Hermes (observer-only SessionStart has no notice channel)", () => {
    expect(reauthNoticeOutput("hermes")).toBeUndefined();
  });

  it("names the recovery command so the notice is actionable", () => {
    expect(REAUTH_NOTICE).toContain("prim auth login");
  });
});
