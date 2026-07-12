/**
 * `prim doctor` verdict contract — the pure classifier.
 *
 * The auth/daemon/journal/server checks have side effects exercised by the
 * release smoke; here we pin the fold that matters: any failed check makes the
 * whole run unhealthy with exit 1, a warning alone is degraded-but-exit-0
 * (actionable, not broken), and the checks pass through verbatim for machine
 * consumers.
 */
import { describe, expect, it } from "vitest";
import {
  type Check,
  type MovesStatus,
  classifyDaemonHealth,
  classifyDoctor,
  classifyMovesStatus,
} from "./doctor.js";

const ok = (name: string): Check => ({ name, status: "ok", detail: "" });
const warn = (name: string): Check => ({ name, status: "warn", detail: "" });
const fail = (name: string): Check => ({ name, status: "fail", detail: "" });

describe("classifyDoctor", () => {
  it("is healthy with exit 0 when every check is ok", () => {
    const { json, exitCode } = classifyDoctor([ok("auth"), ok("daemon")]);
    expect(json.status).toBe("ok");
    expect(json.ok).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("is degraded with exit 0 when a check warns but none fail", () => {
    const { json, exitCode } = classifyDoctor([ok("auth"), warn("daemon"), warn("stranded")]);
    expect(json.status).toBe("warn");
    expect(json.ok).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("is unhealthy with exit 1 when any check fails (fail dominates warn)", () => {
    const { json, exitCode } = classifyDoctor([warn("daemon"), fail("auth"), ok("journal")]);
    expect(json.status).toBe("fail");
    expect(json.ok).toBe(false);
    expect(exitCode).toBe(1);
  });

  it("carries the checks through verbatim for machine consumers", () => {
    const checks = [ok("auth"), warn("stranded")];
    expect(classifyDoctor(checks).json.checks).toEqual(checks);
  });
});

describe("daemon health diagnostics", () => {
  it("fails a socket-live daemon whose durable health is not green", () => {
    const check = classifyDaemonHealth({
      healthy: false,
      heartbeat: { healthy: true, consecutiveFailures: 0 },
      ingestion: {
        healthy: false,
        consecutiveFailures: 1,
        pendingCount: 2,
        pendingSampled: false,
        strandedCount: 0,
        lastAcknowledgedCount: 0,
        lastError: "acknowledgement mismatch",
      },
    });
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("acknowledgement mismatch");
  });

  it("requires the macOS supervisor to be loaded", () => {
    expect(
      classifyDaemonHealth(
        {
          healthy: true,
          heartbeat: { healthy: true, consecutiveFailures: 0 },
          ingestion: {
            healthy: true,
            consecutiveFailures: 0,
            pendingCount: 0,
            pendingSampled: false,
            strandedCount: 0,
            lastAcknowledgedCount: 0,
          },
        },
        { service: { loaded: false } },
      ).status,
    ).toBe("fail");
  });

  it("requires launchd to positively own the socket pid", () => {
    const healthy = {
      pid: 42,
      healthy: true,
      heartbeat: { healthy: true, consecutiveFailures: 0 },
      ingestion: {
        healthy: true,
        consecutiveFailures: 0,
        pendingCount: 0,
        pendingSampled: false,
        strandedCount: 0,
        lastAcknowledgedCount: 0,
      },
    };
    expect(classifyDaemonHealth(healthy, { service: { loaded: true } }).status).toBe("fail");
    expect(classifyDaemonHealth(healthy, { service: { loaded: true, pid: 99 } }).detail).toContain(
      "does not own",
    );
    expect(classifyDaemonHealth(healthy, { service: { loaded: true, pid: 42 } }).status).toBe("ok");
  });
});

describe("moves status diagnostics", () => {
  const status = (overrides: Partial<MovesStatus> = {}): MovesStatus => ({
    captureState: "enabled",
    latestIngestAt: 200,
    latestClassificationAt: 200,
    highWaterMark: 200,
    pendingSessionCount: 0,
    sampled: false,
    ...overrides,
  });

  it("fails capture explicitly when the feature is disabled", () => {
    const [capture] = classifyMovesStatus(status({ captureState: "disabled" }));
    expect(capture.status).toBe("fail");
    expect(capture.detail).toContain("retained");
  });

  it("surfaces classifier backlog without treating in-flight work as lost", () => {
    const [, classification] = classifyMovesStatus(status({ pendingSessionCount: 2 }));
    expect(classification.status).toBe("warn");
    expect(classification.detail).toContain("2 session");
  });
});
