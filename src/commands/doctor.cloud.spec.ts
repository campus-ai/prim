import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyDaemonHealth } from "./doctor.js";

afterEach(() => vi.unstubAllEnvs());

describe("doctor daemon check in Claude Code cloud sessions", () => {
  it("treats the cloud opt-out as healthy: capture delivers directly", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    expect(classifyDaemonHealth(null, { disabled: true })).toEqual({
      name: "daemon",
      status: "ok",
      detail: "not used in Claude Code cloud sessions; capture delivers directly",
    });
  });

  it("still fails an explicit stop on a developer machine", () => {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "");
    expect(classifyDaemonHealth(null, { disabled: true })).toMatchObject({ status: "fail" });
  });
});
