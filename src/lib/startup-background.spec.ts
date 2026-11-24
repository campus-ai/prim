import { describe, expect, it, vi } from "vitest";
import { runStartupBackgroundWork } from "./startup-background.js";

function drains(argv: string[], env: NodeJS.ProcessEnv): boolean {
  const work = { notify: vi.fn(), flush: vi.fn(), healDaemon: vi.fn() };
  runStartupBackgroundWork(argv, env, work);
  return work.flush.mock.calls.length > 0;
}

describe("setup's journal drain", () => {
  it("leaves the drain to the daemon a developer setup starts", () => {
    expect(drains(["setup"], {})).toBe(false);
  });

  it.each([
    [["setup", "--no-daemon"], {}],
    [["setup", "--cloud"], {}],
    [["setup"], { CLAUDE_CODE_REMOTE: "true" }],
  ])("drains for itself when %j starts no daemon", (argv, env) => {
    expect(drains(argv, env)).toBe(true);
  });
});
