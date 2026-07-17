import { describe, expect, it } from "vitest";
import { REAUTH_NOTICE, reauthNoticeFields } from "./reauth-notice.js";

describe("reauthNoticeFields", () => {
  it("routes the notice to Codex developer context (no statusline)", () => {
    expect(reauthNoticeFields("codex")).toEqual({ additionalContext: REAUTH_NOTICE });
  });

  it("routes the notice to Claude Code's systemMessage", () => {
    expect(reauthNoticeFields("claude_code")).toEqual({ systemMessage: REAUTH_NOTICE });
  });

  it("returns nothing for Hermes (observer-only SessionStart has no notice channel)", () => {
    expect(reauthNoticeFields("hermes")).toBeUndefined();
  });

  it("names the recovery command so the notice is actionable", () => {
    expect(REAUTH_NOTICE).toContain("prim auth login");
  });
});
