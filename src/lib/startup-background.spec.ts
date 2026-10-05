import { describe, expect, it, vi } from "vitest";
import { SETUP_DAEMON_DRAINS_ENV, SETUP_ORCHESTRATOR_ENV } from "../commands/setup.js";
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

  const daemonSetupStep = { [SETUP_ORCHESTRATOR_ENV]: "1", [SETUP_DAEMON_DRAINS_ENV]: "1" };

  it.each([
    {
      label: "the steps of a setup that starts the daemon",
      argv: ["doctor", "--expect-backlog"],
      env: daemonSetupStep,
    },
    {
      label: "the steps of a setup that starts the daemon",
      argv: ["daemon", "start"],
      env: daemonSetupStep,
    },
    {
      label: "a setup that starts the daemon",
      argv: ["--yes", "setup", "--agent", "codex"],
      env: {},
    },
  ])("leaves the drain to the daemon for $label ($argv)", ({ argv, env }) => {
    // A background drain holding the lock would make the daemon's sweeps bow
    // out unrecorded, so setup's doctor could never see a delivery failure.
    const background = work();

    runStartupBackgroundWork(argv, env, background);

    expect(background.notify).toHaveBeenCalledOnce();
    expect(background.flush).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "the steps of a --no-daemon setup",
      argv: ["daemon", "stop"],
      env: { [SETUP_ORCHESTRATOR_ENV]: "1" },
    },
    {
      label: "the steps of a --no-daemon setup",
      argv: ["hooks", "install"],
      env: { [SETUP_ORCHESTRATOR_ENV]: "1" },
    },
    {
      label: "a --no-daemon setup",
      argv: ["--yes", "setup", "--agent", "codex", "--no-daemon"],
      env: {},
    },
  ])("still drains for $label ($argv), since no daemon will", ({ argv, env }) => {
    const background = work();

    runStartupBackgroundWork(argv, env, background);

    expect(background.notify).toHaveBeenCalledOnce();
    expect(background.flush).toHaveBeenCalledOnce();
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
