/**
 * `prim doctor` verdict contract — the pure classifier.
 *
 * The auth/daemon/journal/server checks have side effects exercised by the
 * release smoke; here we pin the fold that matters: any failed check makes the
 * whole run unhealthy with exit 1, a warning alone is degraded-but-exit-0
 * (actionable, not broken), and the checks pass through verbatim for machine
 * consumers.
 */
import { Command } from "commander";
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
  type DeliveryProbe,
  type MovesStatus,
  classifyAuthCredential,
  classifyClaudeHooks,
  classifyCodexHooks,
  classifyCursorHooks,
  classifyDaemonHealth,
  classifyDelivery,
  classifyDoctor,
  classifyHermesHooks,
  classifyHookRuntime,
  classifyJournal,
  classifyJournalOrganization,
  classifyManagedHook,
  classifyMovesStatus,
  classifyPostCommitHook,
  classifyRepositoryBinding,
  diagnoseRegisteredHookRuntime,
  refreshOwnedGlobalHooksForHealth,
  registerDoctorCommands,
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
      lastFailedDrainAcknowledgedCount: 0,
      lastRetainedBucketCount: 0,
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
        lastFailedDrainAcknowledgedCount: 0,
        lastRetainedBucketCount: 0,
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
            lastFailedDrainAcknowledgedCount: 0,
            lastRetainedBucketCount: 0,
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
          lastFailedDrainAcknowledgedCount: 0,
          lastRetainedBucketCount: 0,
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

describe("setup's expected-backlog relaxation", () => {
  const DAY_MS = 86_400_000;
  const service = { loaded: true as const, pid: 42 };
  const backlog = () => ({
    pid: 42,
    version: "1.2.3",
    healthy: false,
    needsReauth: false,
    heartbeat: { healthy: true, consecutiveFailures: 0 },
    ingestion: {
      healthy: false,
      consecutiveFailures: 0,
      pendingCount: 1200,
      pendingSampled: true,
      oldestPendingAt: Date.now() - 52 * DAY_MS - 60_000,
      strandedCount: 0,
      lastAcknowledgedCount: 0,
      lastFailedDrainAcknowledgedCount: 0,
      lastRetainedBucketCount: 0,
    },
  });
  const options = {
    service,
    expectedVersion: "1.2.3",
    ingestionStatus: "enabled" as const,
    backlogExpected: true,
  };

  it("reports a live, current, authenticated daemon that is merely behind as draining", () => {
    expect(classifyDaemonHealth(backlog(), options)).toEqual({
      name: "daemon",
      status: "warn",
      detail:
        "supervised and live · v1.2.3 · Decision ingestion enabled · draining at least 1200 pending moves (oldest ≥ 52d) in the background",
    });
  });

  it("leaves standalone doctor failing the same backlog with its existing detail", () => {
    expect(classifyDaemonHealth(backlog(), { ...options, backlogExpected: undefined })).toEqual({
      name: "daemon",
      status: "fail",
      detail: "ingestion unhealthy · at least 1200 pending",
    });
  });

  it("still fails ingestion that is failing rather than behind", () => {
    const failing = backlog();
    expect(
      classifyDaemonHealth(
        {
          ...failing,
          ingestion: { ...failing.ingestion, consecutiveFailures: 3, lastError: "HTTP 400" },
        },
        options,
      ),
    ).toEqual({
      name: "daemon",
      status: "fail",
      detail: "ingestion unhealthy · at least 1200 pending — HTTP 400",
    });
  });

  it("never relaxes terminal auth, heartbeat, version, or supervisor failures", () => {
    expect(classifyDaemonHealth({ ...backlog(), needsReauth: true }, options)).toMatchObject({
      status: "fail",
      detail: "authentication ended — run `prim auth login`",
    });
    expect(
      classifyDaemonHealth(
        {
          ...backlog(),
          heartbeat: { healthy: false, consecutiveFailures: 2, lastError: "HTTP 503" },
        },
        options,
      ),
    ).toMatchObject({ status: "fail", detail: "heartbeat unhealthy — HTTP 503" });
    expect(classifyDaemonHealth({ ...backlog(), version: "1.2.2" }, options)).toMatchObject({
      status: "fail",
      detail: expect.stringContaining("older"),
    });
    expect(
      classifyDaemonHealth(backlog(), { ...options, service: { loaded: false } }),
    ).toMatchObject({ status: "fail" });
    expect(classifyDaemonHealth(null, options)).toMatchObject({ status: "fail" });
  });

  it("keeps every standalone journal verdict unchanged", () => {
    const now = 1_800_000_000_000;
    const stats = { strandedCount: 0, strandedFileCount: 0, strandedSampled: false };
    expect(classifyJournal({ ...stats, pendingCount: 0, sampled: false }, now)).toEqual({
      name: "journal",
      status: "ok",
      detail: "no pending moves",
    });
    expect(classifyJournal({ ...stats, pendingCount: 0, sampled: true }, now)).toEqual({
      name: "journal",
      status: "fail",
      detail: "bounded journal sample could not prove the queue is empty",
    });
    expect(classifyJournal({ ...stats, pendingCount: 3, sampled: false }, now)).toEqual({
      name: "journal",
      status: "fail",
      detail: "3 pending with no readable capture timestamp",
    });
    expect(
      classifyJournal(
        { ...stats, pendingCount: 1200, sampled: true, oldestPendingAt: now - 52 * DAY_MS },
        now,
      ),
    ).toEqual({
      name: "journal",
      status: "fail",
      detail: "at least 1200 pending, oldest observed 4492800s — 30s delivery SLA missed",
    });
    expect(
      classifyJournal(
        { ...stats, pendingCount: 4, sampled: true, oldestPendingAt: now - 1_000 },
        now,
      ),
    ).toEqual({
      name: "journal",
      status: "fail",
      detail: "at least 4 pending in bounded sample; 30s delivery SLA cannot be proven",
    });
    expect(
      classifyJournal(
        { ...stats, pendingCount: 4, sampled: false, oldestPendingAt: now - 1_000 },
        now,
      ),
    ).toEqual({ name: "journal", status: "ok", detail: "4 pending, draining" });
  });

  it("reports backlog size and age as draining, but not an unreadable queue", () => {
    const now = 1_800_000_000_000;
    const stats = { strandedCount: 0, strandedFileCount: 0, strandedSampled: false };
    const expected = { backlogExpected: true };
    expect(
      classifyJournal(
        { ...stats, pendingCount: 1200, sampled: true, oldestPendingAt: now - 52 * DAY_MS },
        now,
        expected,
      ),
    ).toEqual({
      name: "journal",
      status: "warn",
      detail: "at least 1200 pending moves (oldest ≥ 52d) — draining in the background",
    });
    expect(classifyJournal({ ...stats, pendingCount: 0, sampled: true }, now, expected)).toEqual({
      name: "journal",
      status: "warn",
      detail: "an unknown number of pending moves — draining in the background",
    });
    expect(
      classifyJournal({ ...stats, pendingCount: 3, sampled: false }, now, expected),
    ).toMatchObject({ status: "fail", detail: "3 pending with no readable capture timestamp" });
  });

  it("lets setup's doctor pass a draining machine that standalone doctor fails", () => {
    const now = Date.now();
    const stats = {
      pendingCount: 1200,
      sampled: true,
      oldestPendingAt: now - 52 * DAY_MS,
      strandedCount: 0,
      strandedFileCount: 0,
      strandedSampled: false,
    };
    const otherChecks = [ok("auth"), warn("stranded"), ok("journal-org"), ok("connectivity")];
    const standalone = classifyDoctor([
      classifyDaemonHealth(backlog(), { ...options, backlogExpected: false }),
      classifyJournal(stats, now),
      ...otherChecks,
    ]);
    const setup = classifyDoctor([
      classifyDaemonHealth(backlog(), options),
      classifyJournal(stats, now, { backlogExpected: true }),
      ...otherChecks,
    ]);
    expect(standalone).toMatchObject({ json: { status: "fail" }, exitCode: 1 });
    expect(setup).toMatchObject({ json: { ok: true, status: "warn" }, exitCode: 0 });
  });

  describe("classifyDelivery", () => {
    const NOW = 1_800_000_000_000;
    const stats = (overrides: Partial<DeliveryProbe["stats"]> = {}) => ({
      pendingCount: 1200,
      sampled: true,
      oldestPendingAt: NOW - 52 * DAY_MS,
      strandedCount: 0,
      strandedFileCount: 0,
      strandedSampled: false,
      ...overrides,
    });
    const probe = (overrides: Partial<DeliveryProbe> = {}): DeliveryProbe => ({
      snapshot: backlog(),
      service,
      disabled: false,
      expectedVersion: "1.2.3",
      ingestionStatus: "enabled",
      stats: stats(),
      now: NOW,
      ...overrides,
    });

    it("relaxes the journal only beside a daemon check that vouches for the drain", () => {
      expect(classifyDelivery(probe(), { backlogExpected: true })).toEqual([
        {
          name: "daemon",
          status: "warn",
          detail:
            "supervised and live · v1.2.3 · Decision ingestion enabled · draining at least 1200 pending moves (oldest ≥ 52d) in the background",
        },
        {
          name: "journal",
          status: "warn",
          detail: "at least 1200 pending moves (oldest ≥ 52d) — draining in the background",
        },
        { name: "stranded", status: "ok", detail: "none" },
      ]);
    });

    it.each([
      ["an unloaded launchd service", { service: { loaded: false as const } }],
      ["an explicit stop", { disabled: true }],
      ["an unavailable socket", { snapshot: null }],
      ["an unqueryable launchd", { snapshot: null, launchdError: "launchctl exited 5" }],
      [
        "recorded delivery failures",
        {
          snapshot: {
            ...backlog(),
            ingestion: { ...backlog().ingestion, consecutiveFailures: 2, lastError: "HTTP 400" },
          },
        },
      ],
      [
        // A sweep that holds buckets back returns without throwing, so no
        // failure is recorded; its Moves still never deliver on their own.
        "buckets the daemon holds back",
        {
          snapshot: {
            ...backlog(),
            ingestion: {
              ...backlog().ingestion,
              lastRetainedBucketCount: 1,
              lastRetainedReasons: "unbound:1",
            },
          },
        },
      ],
    ])("keeps the journal's own failure next to %s", (_label, overrides) => {
      const [daemon, journal] = classifyDelivery(probe(overrides), { backlogExpected: true });

      expect(daemon?.status).toBe("fail");
      expect(journal).toEqual({
        name: "journal",
        status: "fail",
        detail: "at least 1200 pending, oldest observed 4492800s — 30s delivery SLA missed",
      });
    });

    it("reports the daemon's backlog from the same live scan as the journal check", () => {
      // The daemon refreshes its own count only around its sweeps; one doctor
      // run must not show two different backlogs.
      const live = stats({ pendingCount: 40, sampled: false, oldestPendingAt: NOW - 3_600_000 });
      const [daemon, journal] = classifyDelivery(probe({ stats: live }), {
        backlogExpected: true,
      });

      expect(daemon?.detail).toContain("draining 40 pending moves (oldest 1h) in the background");
      expect(journal?.detail).toBe("40 pending moves (oldest 1h) — draining in the background");
      // Standalone doctor's failing daemon line reads the same scan too.
      expect(classifyDelivery(probe({ stats: live }))[0]).toMatchObject({
        status: "fail",
        detail: "ingestion unhealthy · 40 pending",
      });
    });

    it("says the backlog drained when the live scan is empty before the daemon's next sweep", () => {
      const [daemon, journal] = classifyDelivery(
        probe({ stats: stats({ pendingCount: 0, sampled: false, oldestPendingAt: undefined }) }),
        { backlogExpected: true },
      );

      expect(daemon).toMatchObject({
        status: "warn",
        detail: expect.stringContaining(
          "backlog drained; daemon health refreshes on its next sweep",
        ),
      });
      expect(journal).toEqual({ name: "journal", status: "ok", detail: "no pending moves" });
    });

    it("leaves standalone doctor failing both checks", () => {
      const [daemon, journal] = classifyDelivery(probe());

      expect(daemon).toMatchObject({
        status: "fail",
        detail: "ingestion unhealthy · at least 1200 pending",
      });
      expect(journal?.status).toBe("fail");
    });
  });

  it("wires --expect-backlog from the command line through to the delivery checks", async () => {
    const NOW = Date.now();
    const draining: DeliveryProbe = {
      snapshot: backlog(),
      service,
      disabled: false,
      expectedVersion: "1.2.3",
      ingestionStatus: "enabled",
      stats: {
        pendingCount: 1200,
        sampled: true,
        oldestPendingAt: NOW - 52 * DAY_MS,
        strandedCount: 0,
        strandedFileCount: 0,
        strandedSampled: false,
      },
      now: NOW,
    };
    async function doctor(argv: string[]) {
      const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
      const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
      process.exitCode = undefined;
      try {
        const program = new Command();
        registerDoctorCommands(program, {
          probes: {
            delivery: async () => draining,
            independent: async () => ({ before: [ok("auth")], after: [ok("connectivity")] }),
          },
        });
        await program.parseAsync(argv, { from: "user" });
        return {
          json: JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as {
            status: string;
            checks: Check[];
          },
          exitCode: process.exitCode,
        };
      } finally {
        stderr.mockRestore();
        stdout.mockRestore();
        process.exitCode = undefined;
      }
    }

    const setup = await doctor(["doctor", "--expect-backlog"]);
    const standalone = await doctor(["doctor"]);

    expect(setup.json.status).toBe("warn");
    expect(setup.exitCode).toBeUndefined();
    expect(setup.json.checks.map((check) => [check.name, check.status])).toEqual([
      ["auth", "ok"],
      ["daemon", "warn"],
      ["journal", "warn"],
      ["stranded", "ok"],
      ["connectivity", "ok"],
    ]);
    expect(standalone.json.status).toBe("fail");
    expect(standalone.exitCode).toBe(1);
  });

  it("exposes the relaxation only as a hidden flag", () => {
    const program = new Command();
    registerDoctorCommands(program);
    const doctor = program.commands.find((command) => command.name() === "doctor");
    const option = doctor?.options.find((candidate) => candidate.long === "--expect-backlog");
    expect(option?.hidden).toBe(true);
    expect(doctor?.helpInformation()).not.toContain("--expect-backlog");
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

  it("reports Cursor lifecycle, missing footer, and preserved custom footer distinctly", () => {
    const project = { present: false, gate: false, capture: false, complete: false };
    expect(
      classifyCursorHooks([
        project,
        {
          present: true,
          gate: true,
          capture: true,
          complete: true,
          footer: false,
          footerPreservedCustom: false,
        },
      ]),
    ).toMatchObject({ status: "fail", detail: expect.stringContaining("footer is missing") });
    expect(
      classifyCursorHooks([
        project,
        {
          present: true,
          gate: true,
          capture: true,
          complete: true,
          footer: false,
          footerPreservedCustom: true,
        },
      ]),
    ).toMatchObject({ status: "warn", detail: expect.stringContaining("custom") });
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
    inWorktree: false,
    hookName: "post-commit" as const,
    mode: "auto" as const,
    entrypoint: "ready" as const,
    covered: true,
    executable: true,
    current: true,
  };
  const uncovered = { ...inspection, covered: false, current: false };

  it.each([
    ["missing_block", "run `prim hooks install`"],
    ["stale_block", "run `prim hooks install`"],
    ["unreachable_block", "run `prim hooks install`"],
    ["entrypoint_missing", "run `prim enable` to stage the hook runtime"],
  ] as const)("fails %s with the command that repairs it", (reason, remedy) => {
    expect(classifyManagedHook("post-commit", { ...uncovered, reason })).toMatchObject({
      status: "fail",
      detail: `${reason} · ${remedy} · /repo/.git/hooks/post-commit`,
    });
  });

  it("reports manual wiring as a warning that names the snippet command", () => {
    expect(
      classifyManagedHook("post-commit", { ...uncovered, mode: "manual", reason: "missing" }),
    ).toMatchObject({
      status: "warn",
      detail: expect.stringContaining("prim hooks snippet post-commit"),
    });
  });

  it("passes a hook the user wired to the entrypoint themselves", () => {
    expect(classifyManagedHook("post-commit", { ...inspection, wiring: "user" })).toMatchObject({
      status: "ok",
      detail: expect.stringContaining("wired by user"),
    });
  });

  it("never fails doctor for the warn-only pre-commit check", () => {
    expect(
      classifyManagedHook("pre-commit", {
        ...uncovered,
        hookName: "pre-commit",
        reason: "missing_block",
      }),
    ).toMatchObject({ name: "pre-commit", status: "warn" });
  });

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

describe("GitHub repo connection diagnostics", () => {
  const connected = {
    status: "connected",
    repoSyncId: "repoSync123",
    repositoryFullName: "campus-ai/primitive",
  } as const;
  const unbound = {
    status: "unbound",
    repositoryFullName: "campus-ai/primitive",
  } as const;

  it("accepts a local connection that matches the authoritative server state", () => {
    expect(classifyRepositoryBinding("repoSync123", connected, true)).toMatchObject({
      name: "github-repo-connection",
      status: "ok",
    });
  });

  it("fails a locally valid connection that no longer matches the current origin", () => {
    expect(
      classifyRepositoryBinding("repoSync456", { ...connected, repoSyncId: "repoSync789" }, true),
    ).toMatchObject({
      name: "github-repo-connection",
      status: "fail",
      detail: expect.stringContaining("stale"),
    });
  });

  it.each([undefined, "", "-leading", "a".repeat(65), "bad\nid"])(
    "fails a missing or malformed local GitHub repo connection (%s)",
    (value) => {
      expect(classifyRepositoryBinding(value, connected, true)).toMatchObject({
        name: "github-repo-connection",
        status: "fail",
      });
    },
  );

  it("requires the GitHub repo connection when local capture is active but the server is unconnected", () => {
    const check = classifyRepositoryBinding(undefined, unbound, true);

    expect(check).toMatchObject({
      name: "github-repo-connection",
      status: "warn",
      detail: expect.stringContaining("GitHub repo connection is required"),
    });
    expect(check.detail).toContain("prim github connect");
    expect(check.detail).toContain("repository-specific file attribution");
    expect(check.detail).toContain("Conflict Gate verification");
    expect(check.detail).toContain("commit correlation");
    expect(classifyDoctor([check])).toMatchObject({
      json: { ok: true, status: "warn" },
      exitCode: 0,
    });
  });

  it("requires GitHub repo connection and enable when the server is unconnected and local capture is inactive", () => {
    expect(classifyRepositoryBinding(undefined, unbound, false)).toMatchObject({
      name: "github-repo-connection",
      status: "fail",
      detail: expect.stringContaining("prim github connect"),
    });
  });

  it("retains a valid cached connection as recovery state while the server is unconnected", () => {
    const check = classifyRepositoryBinding("repoSync123", unbound, true);
    expect(check).toMatchObject({ name: "github-repo-connection", status: "warn" });
    expect(check.detail).toContain("retained locally for recovery");
    expect(check.detail).not.toContain("repoSync123");
  });

  it("does not print malformed cached connection content on the unconnected path", () => {
    const check = classifyRepositoryBinding("bad\u001b]52;c;secret\u0007id", unbound, true);
    expect(check).toMatchObject({ name: "github-repo-connection", status: "warn" });
    expect(check.detail).toContain("local cached connection state is invalid");
    expect(check.detail).not.toContain("secret");
    expect(check.detail).not.toContain("\u001b");
  });
});
