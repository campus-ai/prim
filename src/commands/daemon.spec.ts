/**
 * `prim daemon status` exit-code contract — the pure classifier.
 *
 * The spawn/poll/socket side effects are exercised by the release smoke; here
 * we pin the behavior change that matters: a still-booting daemon (pidfile
 * alive, socket not yet answering) is EXIT_BOOTING (3), distinct from hard-down
 * (EXIT_NOT_RUNNING, 2), so a status chained right after start can't misread a
 * healthy boot as a failure.
 */
import { closeSync, mkdtempSync, readFileSync, rmSync, statSync, writeSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { classifyStatus, openDaemonLog } from "./daemon.js";

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

describe("openDaemonLog", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-daemon-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the config dir and an appendable 0600 daemon.log", () => {
    const configDir = join(dir, "prim");
    const logPath = join(configDir, "daemon.log");

    const fd1 = openDaemonLog(configDir);
    try {
      writeSync(fd1, "line-one\n");
    } finally {
      closeSync(fd1);
    }

    // Raw hook payloads never touch this file, but it lives under the same
    // 0700/0600 config tree, so keep the credential-grade posture.
    expect(statSync(logPath).mode & 0o777).toBe(0o600);

    // A second open must append, not truncate — the daemon's log has to
    // survive across restarts to be worth anything.
    const fd2 = openDaemonLog(configDir);
    try {
      writeSync(fd2, "line-two\n");
    } finally {
      closeSync(fd2);
    }
    expect(readFileSync(logPath, "utf-8")).toBe("line-one\nline-two\n");
  });
});
