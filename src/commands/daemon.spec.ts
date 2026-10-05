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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  classifyLaunchdStatus,
  classifyStatus,
  daemonDegradedReason,
  daemonStartFailureReason,
  daemonStartHealthFields,
  daemonStartIsReady,
  formatDaemonLifecycleMessage,
  formatDaemonSnapshotMessage,
  openDaemonLog,
  waitForReadySnapshot,
} from "./daemon.js";

const EXIT_OK = 0;
const EXIT_NOT_RUNNING = 2;
const EXIT_BOOTING = 3;

const NOW = 1_800_000_000_000;
const DAY_MS = 86_400_000;
const healthyHeartbeat = { healthy: true, consecutiveFailures: 0 };
const healthyIngestion = {
  healthy: true,
  consecutiveFailures: 0,
  pendingCount: 0,
  pendingSampled: false,
  strandedCount: 0,
  lastAcknowledgedCount: 0,
  lastFailedDrainAcknowledgedCount: 0,
  lastRetainedBucketCount: 0,
};
// The PRI-68 shape: weeks of Moves queued while auth was dead, so the daemon's
// own ingestion health is red the moment it comes back.
const backlogIngestion = {
  ...healthyIngestion,
  healthy: false,
  pendingCount: 1200,
  pendingSampled: true,
  oldestPendingAt: NOW - 52 * DAY_MS - 1_000,
};
const drainingSnapshot = {
  pid: 4242,
  uptimeMs: 1,
  sessionId: "daemon-4242",
  version: "1.2.3",
  healthy: false,
  needsReauth: false,
  heartbeat: healthyHeartbeat,
  ingestion: backlogIngestion,
};

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
      onlineTeammates: [
        {
          name: "Alex",
          area: "auth",
          decisionUrl: "https://app.getprimitive.ai/decisions/alex-decision",
        },
        { name: "Maya" },
      ],
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

  it("distinguishes absent, unsupervised, and unavailable launchd states", () => {
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
    expect(classifyLaunchdStatus(undefined, true, snapshot, false)).toEqual({
      json: {
        running: true,
        responding: true,
        supervised: true,
        state: "unknown",
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

describe("daemonStartIsReady", () => {
  it("requires a loaded/responding owned service plus matching healthy runtime", () => {
    expect(daemonStartIsReady(true, { healthy: true, version: "1.2.3" }, "1.2.3")).toBe(true);
    expect(daemonStartIsReady(false, { healthy: true, version: "1.2.3" }, "1.2.3")).toBe(false);
    expect(daemonStartIsReady(true, { healthy: false, version: "1.2.3" }, "1.2.3")).toBe(false);
    expect(daemonStartIsReady(true, { healthy: true, version: "old" }, "1.2.3")).toBe(false);
    expect(daemonStartIsReady(true, { healthy: true }, "1.2.3")).toBe(false);
    expect(daemonStartIsReady(true, null, "1.2.3")).toBe(false);
    expect(daemonStartIsReady(true, { healthy: true, version: "1.2.3" }, undefined)).toBe(false);
  });

  it("does not gate on delivery: ready while a backlog drains or its delivery fails", () => {
    expect(daemonStartIsReady(true, drainingSnapshot, "1.2.3")).toBe(true);
    expect(
      daemonStartIsReady(
        true,
        {
          ...drainingSnapshot,
          ingestion: { ...backlogIngestion, consecutiveFailures: 7, lastError: "HTTP 504" },
        },
        "1.2.3",
      ),
    ).toBe(true);
  });

  it("still fails version skew, terminal auth, and an unhealthy heartbeat despite the exemption", () => {
    expect(daemonStartIsReady(true, { ...drainingSnapshot, version: "1.2.2" }, "1.2.3")).toBe(
      false,
    );
    expect(daemonStartIsReady(true, { ...drainingSnapshot, needsReauth: true }, "1.2.3")).toBe(
      false,
    );
    expect(
      daemonStartIsReady(
        true,
        {
          ...drainingSnapshot,
          heartbeat: { healthy: false, consecutiveFailures: 3, lastError: "HTTP 401" },
        },
        "1.2.3",
      ),
    ).toBe(false);
    expect(daemonStartIsReady(true, { ...drainingSnapshot, heartbeat: undefined }, "1.2.3")).toBe(
      false,
    );
    expect(daemonStartIsReady(false, drainingSnapshot, "1.2.3")).toBe(false);
  });

  it("exempts only the ingestion cause of an unhealthy aggregate", () => {
    expect(
      daemonStartIsReady(true, { ...drainingSnapshot, ingestion: healthyIngestion }, "1.2.3"),
    ).toBe(false);
  });
});

describe("waitForReadySnapshot", () => {
  function fakeClock() {
    let now = 0;
    return {
      nowMs: () => now,
      sleep: async (ms: number) => {
        now += ms;
      },
    };
  }

  it("returns once the heartbeat is healthy instead of waiting for the backlog to drain", async () => {
    const snapshots = [
      null,
      { ...drainingSnapshot, heartbeat: { healthy: false, consecutiveFailures: 0 } },
      drainingSnapshot,
      { ...drainingSnapshot, healthy: true, ingestion: healthyIngestion },
    ];
    const requestSnapshot = vi.fn(async () => snapshots.shift() ?? null);

    await expect(
      waitForReadySnapshot("1.2.3", { requestSnapshot, ...fakeClock() }),
    ).resolves.toEqual(drainingSnapshot);
    expect(requestSnapshot).toHaveBeenCalledTimes(3);
  });

  it.each([
    ["terminal auth", { ...drainingSnapshot, needsReauth: true }],
    ["version skew", { ...drainingSnapshot, version: "1.2.2" }],
    [
      "an unhealthy heartbeat",
      { ...drainingSnapshot, heartbeat: { healthy: false, consecutiveFailures: 2 } },
    ],
  ])("polls %s to the deadline and returns the last snapshot", async (_label, snapshot) => {
    const requestSnapshot = vi.fn(async () => snapshot);

    await expect(
      waitForReadySnapshot("1.2.3", { requestSnapshot, ...fakeClock() }),
    ).resolves.toEqual(snapshot);
    expect(requestSnapshot.mock.calls.length).toBeGreaterThan(1);
  });
});

describe("daemonStartHealthFields", () => {
  it("keeps healthy start JSON unchanged", () => {
    expect(
      daemonStartHealthFields(true, {
        pid: 1,
        uptimeMs: 1,
        sessionId: "daemon-1",
        healthy: true,
      }),
    ).toEqual({});
    expect(daemonStartHealthFields(false, null)).toEqual({
      state: "degraded",
      needsReauth: false,
      heartbeat: null,
      ingestion: null,
    });
  });

  it("adds only draining fields to a ready start that is still working through a backlog", () => {
    expect(daemonStartHealthFields(true, drainingSnapshot)).toEqual({
      draining: true,
      ingestion: backlogIngestion,
    });
  });

  it("reports recorded delivery failures distinctly from draining", () => {
    const failing = { ...backlogIngestion, consecutiveFailures: 3, lastError: "HTTP 400" };
    expect(daemonStartHealthFields(true, { ...drainingSnapshot, ingestion: failing })).toEqual({
      draining: false,
      deliveryFailing: true,
      ingestion: failing,
    });
  });

  it("adds the complete degraded snapshot fields to unhealthy start JSON", () => {
    const heartbeat = { healthy: false, consecutiveFailures: 1, lastError: "HTTP 401" };
    const ingestion = {
      healthy: false,
      consecutiveFailures: 1,
      pendingCount: 23,
      pendingSampled: false,
      strandedCount: 0,
      lastAcknowledgedCount: 0,
      lastFailedDrainAcknowledgedCount: 0,
      lastRetainedBucketCount: 0,
    };
    expect(
      daemonStartHealthFields(false, {
        pid: 1,
        uptimeMs: 1,
        sessionId: "daemon-1",
        healthy: false,
        needsReauth: true,
        heartbeat,
        ingestion,
      }),
    ).toEqual({ state: "degraded", needsReauth: true, heartbeat, ingestion });
  });
});

describe("daemonDegradedReason", () => {
  const base = { pid: 4242, uptimeMs: 1, sessionId: "daemon-4242", healthy: false };

  it("prioritizes reauthentication over downstream health errors", () => {
    expect(
      daemonDegradedReason({
        ...base,
        needsReauth: true,
        heartbeat: { healthy: false, consecutiveFailures: 2, lastError: "HTTP 401" },
        ingestion: {
          healthy: false,
          consecutiveFailures: 2,
          pendingCount: 23,
          pendingSampled: false,
          strandedCount: 0,
          lastAcknowledgedCount: 0,
          lastFailedDrainAcknowledgedCount: 0,
          lastRetainedBucketCount: 0,
          lastError: "poison queue",
        },
      }),
    ).toBe("authentication requires `prim auth login`");
  });

  it("surfaces a bounded, control-safe ingestion error and pending count", () => {
    const reason = daemonDegradedReason({
      ...base,
      heartbeat: { healthy: true, consecutiveFailures: 0 },
      ingestion: {
        healthy: false,
        consecutiveFailures: 298,
        pendingCount: 23,
        pendingSampled: true,
        strandedCount: 0,
        lastAcknowledgedCount: 0,
        lastFailedDrainAcknowledgedCount: 0,
        lastRetainedBucketCount: 0,
        lastError: `bad\u001b[2J${"x".repeat(400)}`,
      },
    });

    expect(reason).toContain("ingestion unhealthy (at least 23 pending): bad");
    expect(reason).not.toContain("\u001b");
    expect(reason?.length).toBeLessThan(300);
  });
});

describe("daemonStartFailureReason", () => {
  it("names version skew instead of blaming a backlog that no longer gates start", () => {
    expect(daemonStartFailureReason({ ...drainingSnapshot, version: "1.2.2" }, "1.2.3")).toBe(
      "daemon reports v1.2.2, expected v1.2.3",
    );
    expect(daemonStartFailureReason({ ...drainingSnapshot, version: undefined }, "1.2.3")).toBe(
      "daemon reports no version, expected v1.2.3",
    );
  });

  it("keeps terminal auth and heartbeat causes ahead of ingestion", () => {
    expect(
      daemonStartFailureReason(
        { ...drainingSnapshot, version: "1.2.2", needsReauth: true },
        "1.2.3",
      ),
    ).toBe("authentication requires `prim auth login`");
    expect(
      daemonStartFailureReason(
        {
          ...drainingSnapshot,
          heartbeat: { healthy: false, consecutiveFailures: 1, lastError: "HTTP 503" },
        },
        "1.2.3",
      ),
    ).toBe("heartbeat unhealthy: HTTP 503");
    expect(daemonStartFailureReason(null, "1.2.3")).toBeUndefined();
  });
});

describe("formatDaemonSnapshotMessage", () => {
  const healthy = {
    pid: 4242,
    uptimeMs: 12_000,
    sessionId: "daemon-4242",
    onlineNames: ["Alex", "Maya"],
  };

  it("renders an enabled detached snapshot without dropping runtime metadata", () => {
    expect(formatDaemonSnapshotMessage(healthy, false, "enabled")).toBe(
      "[prim] ✓ daemon live, Decision ingestion enabled · pid=4242 · uptime=12s · session=daemon-4242 · team: Alex, Maya",
    );
  });

  it("renders a disabled supervised snapshot without dropping launchd metadata", () => {
    expect(formatDaemonSnapshotMessage(healthy, true, "disabled")).toBe(
      "[prim] ✓ daemon live, Decision ingestion disabled under launchd · pid=4242 · uptime=12s · session=daemon-4242 · team: Alex, Maya",
    );
  });

  it("surfaces repository-unbound health with a fixed enforcement warning", () => {
    const message = formatDaemonSnapshotMessage(healthy, false, "enabled", "unbound");
    expect(message).toContain("GitHub repo connection: required (run `prim github connect`)");
    expect(message).not.toContain("repoSync");
  });

  it("renders both socket-only success variants without a snapshot", () => {
    expect(formatDaemonSnapshotMessage(null, false, "enabled")).toBe(
      "[prim] ✓ daemon live, Decision ingestion enabled",
    );
    expect(formatDaemonSnapshotMessage(null, true, "disabled")).toBe(
      "[prim] ✓ daemon live, Decision ingestion disabled under launchd (no snapshot)",
    );
  });

  it("leaves degraded output unchanged and omits the location state", () => {
    const message = formatDaemonSnapshotMessage(
      { ...healthy, healthy: false, needsReauth: true },
      true,
      "enabled",
      "unbound",
    );
    expect(message).toBe(
      "[prim] ✗ daemon unhealthy under launchd · pid=4242 · team: Alex, Maya · authentication requires `prim auth login`",
    );
    expect(message).not.toContain("Decision ingestion");
    expect(message).not.toContain("repository:");
  });
});

describe("formatDaemonLifecycleMessage", () => {
  it.each([
    {
      message: "[prim] daemon already running (pid=4242)",
      state: "enabled" as const,
      expected: "[prim] daemon already running (pid=4242) · Decision ingestion enabled",
    },
    {
      message: "[prim] ✓ daemon started (pid=4242, socket=/tmp/prim.sock)",
      state: "disabled" as const,
      expected:
        "[prim] ✓ daemon started (pid=4242, socket=/tmp/prim.sock) · Decision ingestion disabled",
    },
    {
      message: "[prim] ✓ daemon started under launchd (pid=4242)",
      state: "enabled" as const,
      expected: "[prim] ✓ daemon started under launchd (pid=4242) · Decision ingestion enabled",
    },
    {
      message: "[prim] ✓ daemon ensured under launchd (kickstart)",
      state: "disabled" as const,
      expected: "[prim] ✓ daemon ensured under launchd (kickstart) · Decision ingestion disabled",
    },
  ])("appends $state without changing lifecycle metadata", ({ message, state, expected }) => {
    expect(formatDaemonLifecycleMessage(message, state)).toBe(expected);
  });

  it("leaves a healthy snapshot's lifecycle line unchanged", () => {
    expect(
      formatDaemonLifecycleMessage(
        "[prim] ✓ daemon started under launchd (pid=4242)",
        "enabled",
        { ingestion: healthyIngestion },
        NOW,
      ),
    ).toBe("[prim] ✓ daemon started under launchd (pid=4242) · Decision ingestion enabled");
  });

  it("states distinctly that a ready daemon is draining a backlog in the background", () => {
    expect(
      formatDaemonLifecycleMessage(
        "[prim] ✓ daemon started under launchd (pid=4242)",
        "enabled",
        drainingSnapshot,
        NOW,
      ),
    ).toBe(
      "[prim] ✓ daemon started under launchd (pid=4242) · Decision ingestion enabled · draining at least 1200 pending moves (oldest ≥ 52d) in the background",
    );
  });

  it("warns, and never says draining, while the daemon records delivery failures", () => {
    const failing = {
      ingestion: { ...backlogIngestion, consecutiveFailures: 3, lastError: "HTTP 504\n  gateway" },
    };
    expect(
      formatDaemonLifecycleMessage(
        "[prim] ✓ daemon started under launchd (pid=4242)",
        "enabled",
        failing,
        NOW,
      ),
    ).toBe(
      "[prim] ⚠ daemon started under launchd (pid=4242) · Decision ingestion enabled · delivery failing (3 consecutive failures): HTTP 504 gateway · retrying at least 1200 pending moves (oldest ≥ 52d) in the background",
    );
    // A line with no verdict icon keeps its text; only the clause changes.
    expect(
      formatDaemonLifecycleMessage(
        "[prim] daemon already running (pid=4242)",
        "enabled",
        failing,
        NOW,
      ),
    ).toBe(
      "[prim] daemon already running (pid=4242) · Decision ingestion enabled · delivery failing (3 consecutive failures): HTTP 504 gateway · retrying at least 1200 pending moves (oldest ≥ 52d) in the background",
    );
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
