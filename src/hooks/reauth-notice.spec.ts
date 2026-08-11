import { describe, expect, it } from "vitest";
import { REAUTH_NOTICE, reauthNoticeFields } from "./reauth-notice.js";

describe("reauthNoticeFields", () => {
  it("returns nothing for Codex — terminal auth renders inside its status report", () => {
    expect(reauthNoticeFields("codex")).toBeUndefined();
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
