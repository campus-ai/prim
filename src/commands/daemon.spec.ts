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
import {
  classifyLaunchdStatus,
  classifyStatus,
  daemonStartIsHealthy,
  openDaemonLog,
} from "./daemon.js";

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

  it("folds the snapshot — including the full online-teammate list — into a live, exit-0 verdict", () => {
    const snapshot = {
      pid: 4242,
      uptimeMs: 12_000,
      sessionId: "daemon-4242",
      onlineCount: 3,
      onlineNames: ["Alex", "Maya"],
    };
    const { json, exitCode } = classifyStatus(true, true, snapshot, 4242);
    expect(json).toEqual({ running: true, responding: true, ...snapshot });
    expect(exitCode).toBe(EXIT_OK);
  });

  it("reports a responding but unhealthy snapshot as degraded", () => {
    const snapshot = {
      pid: 4242,
      uptimeMs: 12_000,
      sessionId: "daemon-4242",
      healthy: false,
    };
    expect(classifyStatus(true, true, snapshot, 4242)).toEqual({
      json: { running: true, responding: true, state: "degraded", ...snapshot },
      exitCode: EXIT_BOOTING,
    });
  });
});

describe("classifyLaunchdStatus", () => {
  const snapshot = {
    pid: 4242,
    uptimeMs: 12_000,
    sessionId: "daemon-4242",
  };

  it("distinguishes an unloaded service from an unsupervised legacy daemon", () => {
    expect(classifyLaunchdStatus({ loaded: false }, false, null, true)).toEqual({
      json: { running: false, supervised: true, loaded: false, disabled: true },
      exitCode: EXIT_NOT_RUNNING,
    });
    expect(classifyLaunchdStatus({ loaded: false }, true, snapshot, false)).toEqual({
      json: {
        running: true,
        responding: true,
        supervised: false,
        state: "unsupervised",
        disabled: false,
        ...snapshot,
      },
      exitCode: EXIT_BOOTING,
    });
  });

  it("reports a loaded but silent launchd service as booting", () => {
    expect(
      classifyLaunchdStatus({ loaded: true, state: "waiting", pid: 4242 }, false, null, false),
    ).toEqual({
      json: {
        running: true,
        responding: false,
        supervised: true,
        state: "waiting",
        pid: 4242,
        disabled: false,
      },
      exitCode: EXIT_BOOTING,
    });
  });

  it("rejects a socket owned by a pid other than launchd's process", () => {
    expect(
      classifyLaunchdStatus({ loaded: true, state: "running", pid: 999 }, true, snapshot, false),
    ).toEqual({
      json: {
        running: true,
        responding: true,
        supervised: true,
        state: "pid_mismatch",
        pid: 999,
        socketPid: 4242,
        disabled: false,
      },
      exitCode: EXIT_BOOTING,
    });
  });

  it("requires launchctl to positively identify the socket-owning pid", () => {
    expect(
      classifyLaunchdStatus({ loaded: true, state: "running" }, true, snapshot, false),
    ).toEqual({
      json: {
        running: true,
        responding: true,
        supervised: true,
        state: "ownership_unverified",
        pid: undefined,
        socketPid: 4242,
        disabled: false,
      },
      exitCode: EXIT_BOOTING,
    });
  });

  it("returns nonzero for a supervised daemon whose health is degraded", () => {
    expect(
      classifyLaunchdStatus(
        { loaded: true, state: "running", pid: 4242 },
        true,
        { ...snapshot, healthy: false },
        false,
      ),
    ).toEqual({
      json: {
        running: true,
        responding: true,
        supervised: true,
        state: "degraded",
        disabled: false,
        ...snapshot,
        healthy: false,
      },
      exitCode: EXIT_BOOTING,
    });
  });
});

describe("daemonStartIsHealthy", () => {
  it("requires a loaded/responding owned service plus matching healthy runtime", () => {
    expect(daemonStartIsHealthy(true, { healthy: true, version: "1.2.3" }, "1.2.3")).toBe(true);
    expect(daemonStartIsHealthy(false, { healthy: true, version: "1.2.3" }, "1.2.3")).toBe(false);
    expect(daemonStartIsHealthy(true, { healthy: false, version: "1.2.3" }, "1.2.3")).toBe(false);
    expect(daemonStartIsHealthy(true, { healthy: true, version: "old" }, "1.2.3")).toBe(false);
    expect(daemonStartIsHealthy(true, { healthy: true }, "1.2.3")).toBe(false);
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
