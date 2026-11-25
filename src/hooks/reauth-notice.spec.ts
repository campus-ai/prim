import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REAUTH_NOTICE, reauthNoticeFields } from "./reauth-notice.js";

describe("reauthNoticeFields", () => {
  let configDir: string;
  beforeEach(() => {
    // Whether machine credentials are configured must not depend on the host.
    configDir = mkdtempSync(join(tmpdir(), "prim-reauth-"));
    vi.stubEnv("PRIM_CONFIG_DIR", configDir);
    for (const name of [
      "PRIM_M2M_CLIENT_ID",
      "PRIM_M2M_CLIENT_SECRET",
      "PRIM_M2M_CLIENT_AUTH",
      "PRIM_TOKEN",
      "PRIM_CLOUD_IDENTITY",
    ])
      vi.stubEnv(name, undefined);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(configDir, { recursive: true, force: true });
  });

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

  it("tells a cloud session's agent that its credentials were rejected, and how the owner fixes them", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "secret");
    const notice = reauthNoticeFields("claude_code");
    expect(notice?.systemMessage).toContain(
      "Primitive is not connected in this Claude Code cloud session: its credentials were rejected.",
    );
    expect(notice?.systemMessage).toContain("then start a new cloud session");
    expect(notice?.systemMessage).not.toContain("administrator");
    // The web transcript shows no systemMessage: the agent relays it.
    expect(notice?.additionalContext).toBe(
      `${notice?.systemMessage} Tell the user this in one sentence before starting their task.`,
    );
  });

  it("sends an organization-shared environment's admin to --new-environment", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_CLOUD_IDENTITY", "session");
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_shared");
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", "secret");
    const notice = reauthNoticeFields("claude_code");
    expect(notice?.systemMessage).toContain(
      "Primitive is not connected in this Claude Code cloud session: its environment credential was rejected.",
    );
    expect(notice?.systemMessage).toContain("--new-environment");
    expect(notice?.systemMessage).not.toContain("--new-installation");
  });

  it("never sends a cloud session to `prim auth login`, which it refuses", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    const notice = reauthNoticeFields("claude_code");
    expect(notice?.systemMessage).toContain("its sign-in ended");
    expect(notice?.systemMessage).toContain("PRIM_M2M_CLIENT_ID");
    expect(notice?.systemMessage).not.toContain("prim auth login");
    expect(notice?.additionalContext).toContain("Tell the user this in one sentence");
  });
});
