import { describe, expect, it, vi } from "vitest";
import { UNINSTALL_ORCHESTRATOR_ENV } from "../commands/uninstall.js";
import { runStartupBackgroundWork } from "./startup-background.js";

function work() {
  return { notify: vi.fn(), flush: vi.fn() };
}

describe("runStartupBackgroundWork", () => {
  it.each([{ argv: ["--yes", "uninstall"] }, { argv: ["--non-interactive", "uninstall"] }])(
    "keeps $argv offline before notifier or journal drain",
    ({ argv }) => {
      const background = work();

      runStartupBackgroundWork(argv, {}, background);

      expect(background.notify).not.toHaveBeenCalled();
      expect(background.flush).not.toHaveBeenCalled();
    },
  );

  it("keeps orchestrated child commands offline", () => {
    const background = work();

    runStartupBackgroundWork(["daemon", "stop"], { [UNINSTALL_ORCHESTRATOR_ENV]: "1" }, background);

    expect(background.notify).not.toHaveBeenCalled();
    expect(background.flush).not.toHaveBeenCalled();
  });

  it("skips only the redundant drain for an explicit moves flush", () => {
    const background = work();

    runStartupBackgroundWork(["--yes", "moves", "flush"], {}, background);

    expect(background.notify).toHaveBeenCalledOnce();
    expect(background.flush).not.toHaveBeenCalled();
  });

  it.each([["claude", "preauth"], ["daemon", "start"], ["doctor"], ["moves", "status"]])(
    "hands %s's opportunistic drain off synchronously, never awaiting it",
    (...argv) => {
      const background = work();

      // Returning nothing (not a promise) is the contract: the command must not
      // be able to wait on, or be kept alive by, the drain.
      expect(runStartupBackgroundWork(argv, {}, background)).toBeUndefined();
      expect(background.flush).toHaveBeenCalledOnce();
      expect(background.flush).toHaveBeenCalledWith();
    },
  );
});
