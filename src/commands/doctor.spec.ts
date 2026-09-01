/**
 * `prim doctor` verdict contract — the pure classifier.
 *
 * The auth/daemon/journal/server checks have side effects exercised by the
 * release smoke; here we pin the fold that matters: any failed check makes the
 * whole run unhealthy with exit 1, a warning alone is degraded-but-exit-0
 * (actionable, not broken), and the checks pass through verbatim for machine
 * consumers.
 */
import { describe, expect, it, vi } from "vitest";
import { stableHookCommand } from "../lib/bin-path.js";
vi.mock("./hooks.js", () => ({ refreshOwnedGlobalHooks: vi.fn() }));

import {
  applyInstall as applyClaudeInstall,
  hookRuntimeResolutions as claudeRuntimeResolutions,
  feedbackInstalled,
  hasCompleteHookRegistration as hasCompleteClaudeHooks,
} from "./claude-install.js";
import {
  type Check,
  type MovesStatus,
  classifyAuthCredential,
  classifyClaudeHooks,
  classifyCodexHooks,
  classifyDaemonHealth,
  classifyDoctor,
  classifyHermesHooks,
  classifyHookRuntime,
  classifyJournalOrganization,
  classifyManagedHook,
  classifyMovesStatus,
  classifyPostCommitHook,
  classifyRepositoryBinding,
  diagnoseRegisteredHookRuntime,
  refreshOwnedGlobalHooksForHealth,
} from "./doctor.js";
import { refreshOwnedGlobalHooks } from "./hooks.js";

const ok = (name: string): Check => ({ name, status: "ok", detail: "" });
const warn = (name: string): Check => ({ name, status: "warn", detail: "" });
const fail = (name: string): Check => ({ name, status: "fail", detail: "" });

describe("global hook health repair", () => {
  it("refreshes Prim-owned hooks before health inspection", () => {
    refreshOwnedGlobalHooksForHealth();

    expect(refreshOwnedGlobalHooks).toHaveBeenCalledOnce();
  });

  it("preserves health diagnostics when repair fails", () => {
    vi.mocked(refreshOwnedGlobalHooks).mockImplementation(() => {
      throw new Error("unable to rewrite hooks");
    });

    expect(() => refreshOwnedGlobalHooksForHealth()).not.toThrow();
  });
});

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

describe("journal organization diagnostics", () => {
  it("is healthy when no journal buckets exist or every bucket matches", () => {
    expect(classifyJournalOrganization(0, [])).toEqual({
      name: "journal-org",
      status: "ok",
      detail: "no pending organization buckets",
    });
    expect(classifyJournalOrganization(2, [])).toEqual({
      name: "journal-org",
      status: "ok",
      detail: "all pending buckets match the active credential",
    });
  });

  it("fails closed with a bounded, grouped retention reason", () => {
    const check = classifyJournalOrganization(3, [
      { bucket: "org-a", reason: "organization_mismatch" },
      { bucket: "org-b", reason: "organization_mismatch" },
      { bucket: "_unbound", reason: "unbound" },
    ]);
    expect(check).toEqual({
      name: "journal-org",
      status: "fail",
      detail: "3 bucket(s) retained (organization_mismatch:2, unbound:1)",
    });
    expect(classifyDoctor([check])).toMatchObject({
      json: { ok: false, status: "fail" },
      exitCode: 1,
    });
  });
});

describe("auth source diagnostics", () => {
  it("ignores stale browser metadata for selected fixed credentials", () => {
    for (const source of ["environment"] as const) {
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

  it("fails deployment, principal, and both daemon/package version skew directions", () => {
    const service = { loaded: true, pid: 42 };
    expect(classifyDaemonHealth({ ...healthy, envMismatch: true }, { service }).detail).toContain(
      "deployment differs",
    );
    expect(
      classifyDaemonHealth({ ...healthy, principalMismatch: true }, { service }).detail,
    ).toContain("credential or organization");
    expect(
      classifyDaemonHealth({ ...healthy, version: "1.2.2" }, { service, expectedVersion: "1.2.3" })
        .detail,
    ).toContain("older");
    expect(
      classifyDaemonHealth({ ...healthy, version: "1.2.4" }, { service, expectedVersion: "1.2.3" })
        .detail,
    ).toContain("newer");
    expect(
      classifyDaemonHealth(
        { ...healthy, version: "invalid" },
        { service, expectedVersion: "1.2.3" },
      ).detail,
    ).toContain("malformed");
  });
});

describe("agent hook diagnostics", () => {
  it("requires every Claude registration and includes a persisted statusline runtime", () => {
    const installed = applyClaudeInstall({});
    expect(hasCompleteClaudeHooks(installed)).toBe(true);
    const partial = structuredClone(installed);
    partial.hooks?.PostToolUseFailure?.splice(0, 1);
    expect(feedbackInstalled(partial)).toBe(true);
    expect(hasCompleteClaudeHooks(partial)).toBe(false);
    expect(
      claudeRuntimeResolutions({
        statusLine: { type: "command", command: stableHookCommand("prim-statusline") },
      }),
    ).toEqual([{ kind: "stable_launcher" }]);
  });

  it("fails incomplete Claude, Codex, and Hermes lifecycles", () => {
    expect(
      classifyClaudeHooks([{ present: true, gate: true, capture: true, complete: false }]),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("Claude lifecycle") });
    expect(
      classifyCodexHooks([{ present: true, gate: true, capture: true, complete: false }]).status,
    ).toBe("fail");
    expect(
      classifyHermesHooks({
        present: true,
        gate: true,
        capture: true,
        complete: false,
        autoAccept: true,
      }).status,
    ).toBe("fail");
  });

  it("keeps unused optional agents neutral and describes trust state", () => {
    expect(
      classifyCodexHooks([{ present: false, gate: false, capture: false, complete: false }]).status,
    ).toBe("ok");
    expect(
      classifyHermesHooks({
        present: false,
        gate: false,
        capture: false,
        complete: false,
        autoAccept: false,
      }).status,
    ).toBe("ok");
  });
});

describe("hook runtime diagnostics", () => {
  const stable = [{ kind: "stable_launcher" }] as const;
  const exactNpx = [{ kind: "exact_npx_fallback", version: "1.2.3" }] as const;
  const legacy = [{ kind: "legacy_path" }] as const;

  it("does not touch runtime state when no Primitive registration exists", () => {
    const inspect = vi.fn(() => ({ state: "missing" }) as const);
    const version = vi.fn(() => "1.2.3");
    expect(diagnoseRegisteredHookRuntime([], inspect, version)).toEqual({
      name: "hook-runtime",
      status: "ok",
      detail: "not required: no Primitive hook registrations",
    });
    expect(inspect).not.toHaveBeenCalled();
    expect(version).not.toHaveBeenCalled();
  });

  it("fails closed for an exact npx fallback without executing it", () => {
    const inspect = vi.fn(() => ({ state: "ready", version: "1.2.2" }) as const);
    expect(diagnoseRegisteredHookRuntime(exactNpx, inspect, () => "1.2.3")).toEqual({
      name: "hook-runtime",
      status: "fail",
      detail: expect.stringContaining("cannot be safely verified"),
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("fails closed for a bare PATH hook without executing it", () => {
    const inspect = vi.fn(() => ({ state: "ready", version: "1.2.3" }) as const);
    expect(diagnoseRegisteredHookRuntime(legacy, inspect, () => "1.2.3")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("legacy PATH"),
    });
    expect(inspect).not.toHaveBeenCalled();
  });

  it("does not let a stable hook mask an active exact statusline fallback", () => {
    const inspect = vi.fn(() => ({ state: "ready", version: "1.2.3" }) as const);
    expect(
      diagnoseRegisteredHookRuntime([...stable, ...exactNpx], inspect, () => "1.2.3"),
    ).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("exact npx fallback"),
    });
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it("guides a newer selected runtime toward a matching CLI rather than downgrade", () => {
    expect(classifyHookRuntime({ state: "ready", version: "1.2.4" }, "1.2.3")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("upgrade this CLI"),
    });
    expect(classifyHookRuntime({ state: "ready", version: "1.2.2" }, "1.2.3")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("older"),
    });
    expect(classifyHookRuntime({ state: "invalid" }, "1.2.3")).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("remove or repair"),
    });
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

  it("ignores classifier-session backlog and sampling", () => {
    const checks = classifyMovesStatus(
      status({ pendingSessionCount: 2, oldestPendingAgeMs: 65_000, sampled: true }),
    );
    expect(checks).toEqual([
      { name: "capture", status: "ok", detail: "enabled; ingest endpoint durable" },
    ]);
    expect(checks.some((check) => check.name === "classification")).toBe(false);
    expect(classifyDoctor(checks)).toMatchObject({
      json: { ok: true, status: "ok", checks },
      exitCode: 0,
    });
  });

  it("surfaces the additive commit-correlation backlog without breaking old responses", () => {
    expect(classifyMovesStatus(status())).toHaveLength(1);
    const checks = classifyMovesStatus(status({ pendingCommitCorrelationCount: 3 }));
    expect(checks[1]).toMatchObject({
      name: "commit-correlation",
      status: "warn",
    });
    expect(checks[1].detail).toContain("3 commit");
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

describe("effective post-rewrite diagnostics", () => {
  const inspection = {
    gitRoot: "/repo",
    hooksDir: "/repo/.git/hooks",
    hookPath: "/repo/.git/hooks/post-rewrite",
    kind: "direct" as const,
    covered: true,
    executable: true,
    current: true,
  };

  it("reports independent healthy coverage", () => {
    expect(classifyManagedHook("post-rewrite", inspection)).toMatchObject({
      name: "post-rewrite",
      status: "ok",
      detail: expect.stringContaining("post-rewrite"),
    });
  });

  it("fails independently when the effective dispatcher is missing", () => {
    expect(
      classifyManagedHook("post-rewrite", {
        ...inspection,
        covered: false,
        executable: false,
        current: false,
        reason: "husky_dispatcher_missing",
      }),
    ).toMatchObject({
      name: "post-rewrite",
      status: "fail",
      detail: expect.stringContaining("husky_dispatcher_missing"),
    });
  });
});

describe("repository binding diagnostics", () => {
  const connected = {
    status: "connected",
    repoSyncId: "repoSync123",
    repositoryFullName: "campus-ai/primitive",
  } as const;
  const unbound = {
    status: "unbound",
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

  it("degrades without an enable loop when local capture is active but the server is unbound", () => {
    const check = classifyRepositoryBinding(undefined, unbound, true);

    expect(check).toMatchObject({
      name: "repo-binding",
      status: "warn",
      detail: expect.stringContaining("repository is unbound"),
    });
    expect(check.detail).toContain("prim github connect");
    expect(check.detail).not.toContain("organization owner/admin");
    expect(check.detail).not.toContain("prim enable");
    expect(classifyDoctor([check])).toMatchObject({
      json: { ok: true, status: "warn" },
      exitCode: 0,
    });
  });

  it("still requires enable when the server is unbound and local capture is inactive", () => {
    expect(classifyRepositoryBinding(undefined, unbound, false)).toMatchObject({
      name: "repo-binding",
      status: "fail",
      detail: expect.stringContaining("prim enable"),
    });
  });

  it("retains a valid cached binding as recovery state while the server is unbound", () => {
    const check = classifyRepositoryBinding("repoSync123", unbound, true);
    expect(check).toMatchObject({ name: "repo-binding", status: "warn" });
    expect(check.detail).toContain("retained locally for recovery");
    expect(check.detail).not.toContain("repoSync123");
  });

  it("does not print malformed cached binding content on the unbound path", () => {
    const check = classifyRepositoryBinding("bad\u001b]52;c;secret\u0007id", unbound, true);
    expect(check).toMatchObject({ name: "repo-binding", status: "warn" });
    expect(check.detail).toContain("local cached binding is invalid");
    expect(check.detail).not.toContain("secret");
    expect(check.detail).not.toContain("\u001b");
  });
});
