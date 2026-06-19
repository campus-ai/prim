/**
 * `prim daemon status` exit-code contract — the pure classifier.
 *
 * The spawn/poll/socket side effects are exercised by the release smoke; here
 * we pin the behavior change that matters: a still-booting daemon (pidfile
 * alive, socket not yet answering) is EXIT_BOOTING (3), distinct from hard-down
 * (EXIT_NOT_RUNNING, 2), so a status chained right after start can't misread a
 * healthy boot as a failure.
 */
import { describe, expect, it } from "vitest";
import { classifyStatus } from "./daemon.js";

const EXIT_OK = 0;
const EXIT_NOT_RUNNING = 2;
const EXIT_BOOTING = 3;

describe("classifyStatus", () => {
  it("reports hard-down with exit 2 when no live pid", () => {
    const { json, exitCode } = classifyStatus(false, false, null);
    expect(json).toEqual({ running: false });
    expect(exitCode).toBe(EXIT_NOT_RUNNING);
  });

  it("reports booting with exit 3 when the pid is alive but the socket is silent", () => {
    const { json, exitCode } = classifyStatus(true, false, null, 4242);
    expect(json).toEqual({ running: true, responding: false, state: "starting", pid: 4242 });
    expect(exitCode).toBe(EXIT_BOOTING);
  });

  it("reports live with exit 0, even before a snapshot is available", () => {
    const { json, exitCode } = classifyStatus(true, true, null);
    expect(json).toEqual({ running: true, responding: true });
    expect(exitCode).toBe(EXIT_OK);
  });

  it("folds the snapshot into a live, exit-0 verdict", () => {
    const snapshot = {
      pid: 4242,
      uptimeMs: 12_000,
      sessionId: "daemon-4242",
      onlineCount: 3,
    };
    const { json, exitCode } = classifyStatus(true, true, snapshot, 4242);
    expect(json).toEqual({ running: true, responding: true, ...snapshot });
    expect(exitCode).toBe(EXIT_OK);
  });
});
