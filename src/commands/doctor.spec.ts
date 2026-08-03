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
  classifyAuthCredential,
  classifyDaemonHealth,
  classifyDoctor,
  classifyMovesStatus,
  classifyPostCommitHook,
  classifyRepositoryBinding,
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

describe("auth source diagnostics", () => {
  it("ignores stale browser metadata for selected fixed credentials", () => {
    for (const source of ["environment", "env_file"] as const) {
      expect(classifyAuthCredential({ token: "fixed", source }, 0, true)).toEqual({
        name: "auth",
        status: "ok",
        detail: "valid fixed bearer credential",
      });
    }
  });
});

describe("daemon health diagnostics", () => {
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

  it.each(["enabled", "disabled"] as const)(
    "adds the %s location ingestion state only to healthy daemon detail",
    (ingestionStatus) => {
      expect(
        classifyDaemonHealth(
          { ...healthy, version: "1.2.3" },
          { service: { loaded: true, pid: 42 }, ingestionStatus },
        ),
      ).toEqual({
        name: "daemon",
        status: "ok",
        detail: `supervised and healthy · v1.2.3 · Decision ingestion ${ingestionStatus}`,
      });
    },
  );

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
    expect(classifyDaemonHealth(healthy, { service: { loaded: true } }).status).toBe("fail");
    expect(classifyDaemonHealth(healthy, { service: { loaded: true, pid: 99 } }).detail).toContain(
      "does not own",
    );
    expect(classifyDaemonHealth(healthy, { service: { loaded: true, pid: 42 } }).status).toBe("ok");
  });

  it("surfaces a terminal-auth-death daemon as an actionable re-auth prompt", () => {
    const check = classifyDaemonHealth(
      {
        pid: 42,
        healthy: false,
        needsReauth: true,
        // Heartbeat is unhealthy too, but re-auth is the actionable cause and
        // must win over the opaque "heartbeat unhealthy — HTTP 500".
        heartbeat: { healthy: false, consecutiveFailures: 5, lastError: "HTTP 500" },
        ingestion: {
          healthy: true,
          consecutiveFailures: 0,
          pendingCount: 0,
          pendingSampled: false,
          strandedCount: 0,
          lastAcknowledgedCount: 0,
        },
      },
      { service: { loaded: true, pid: 42 } },
    );
    expect(check.status).toBe("fail");
    expect(check.detail).toContain("prim auth login");
    expect(check.detail).not.toContain("HTTP 500");
  });

  it("leaves unhealthy detail unchanged when an ingestion state is supplied", () => {
    expect(
      classifyDaemonHealth(
        { ...healthy, healthy: false },
        { service: { loaded: true, pid: 42 }, ingestionStatus: "enabled" },
      ),
    ).toEqual({ name: "daemon", status: "fail", detail: "health state is not ready" });
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
    const [, classification] = classifyMovesStatus(
      status({ pendingSessionCount: 2, oldestPendingAgeMs: 65_000 }),
    );
    expect(classification.status).toBe("warn");
    expect(classification.detail).toContain("2 session");
    expect(classification.detail).toContain("oldest 65s");
  });

  it("surfaces the additive commit-correlation backlog without breaking old responses", () => {
    expect(classifyMovesStatus(status())).toHaveLength(2);
    const checks = classifyMovesStatus(status({ pendingCommitCorrelationCount: 3 }));
    expect(checks[2]).toMatchObject({
      name: "commit-correlation",
      status: "warn",
    });
    expect(checks[2].detail).toContain("3 commit");
  });
});

describe("effective post-commit diagnostics", () => {
  const inspection = {
    gitRoot: "/repo",
    hooksDir: "/repo/.git/hooks",
    hookPath: "/repo/.git/hooks/post-commit",
    kind: "direct" as const,
    covered: true,
    executable: true,
    current: true,
  };

  it("passes only a current executable effective hook", () => {
    expect(classifyPostCommitHook(inspection)).toMatchObject({
      name: "post-commit",
      status: "ok",
    });
  });

  it("fails an uncovered effective hook with an actionable reason", () => {
    expect(
      classifyPostCommitHook({
        ...inspection,
        covered: false,
        executable: false,
        current: false,
        reason: "not_executable",
      }),
    ).toMatchObject({
      name: "post-commit",
      status: "fail",
      detail: expect.stringContaining("not_executable"),
    });
  });
});

describe("repository binding diagnostics", () => {
  const connected = {
    status: "connected",
    repoSyncId: "repoSync123",
    repositoryFullName: "campus-ai/primitive",
  } as const;
  const pending = {
    status: "pending",
    repositoryFullName: "campus-ai/primitive",
  } as const;

  it("accepts a local binding that matches the authoritative server binding", () => {
    expect(classifyRepositoryBinding("repoSync123", connected, true)).toMatchObject({
      name: "repo-binding",
      status: "ok",
    });
  });

  it("fails a locally valid binding that no longer matches the current origin", () => {
    expect(
      classifyRepositoryBinding("repoSync456", { ...connected, repoSyncId: "repoSync789" }, true),
    ).toMatchObject({
      name: "repo-binding",
      status: "fail",
      detail: expect.stringContaining("stale"),
    });
  });

  it.each([undefined, "", "-leading", "a".repeat(65), "bad\nid"])(
    "fails a missing or malformed local binding (%s)",
    (value) => {
      expect(classifyRepositoryBinding(value, connected, true)).toMatchObject({
        name: "repo-binding",
        status: "fail",
      });
    },
  );

  it("degrades without an enable loop when local capture is active but connection is pending", () => {
    const check = classifyRepositoryBinding(undefined, pending, true);

    expect(check).toMatchObject({
      name: "repo-binding",
      status: "warn",
      detail: expect.stringContaining("campus-ai/primitive"),
    });
    expect(check.detail).toContain("organization owner/admin");
    expect(check.detail).toContain("retried automatically next SessionStart");
    expect(check.detail).not.toContain("prim enable");
    expect(classifyDoctor([check])).toMatchObject({
      json: { ok: true, status: "warn" },
      exitCode: 0,
    });
  });

  it("still requires enable when connection is pending and local capture is inactive", () => {
    expect(classifyRepositoryBinding(undefined, pending, false)).toMatchObject({
      name: "repo-binding",
      status: "fail",
      detail: expect.stringContaining("prim enable"),
    });
  });

  it.each(["repoSync123", "malformed id"])(
    "fails a stale local binding while connection is pending (%s)",
    (value) => {
      expect(classifyRepositoryBinding(value, pending, true)).toMatchObject({
        name: "repo-binding",
        status: "fail",
        detail: expect.stringContaining("stale"),
      });
    },
  );
});
