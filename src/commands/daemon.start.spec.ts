/**
 * `prim daemon start | restart | ensure` on macOS — the command output, JSON,
 * and exit code a caller (notably `prim setup`) gates on. launchd and the
 * daemon socket are mocked; the snapshot shapes match server.ts's
 * status_snapshot. The regression pinned here is PRI-68: a reinstall with a
 * weeks-old journal backlog could never pass start (and so setup), because
 * readiness waited for the whole backlog to drain.
 */
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { daemonRequest } from "../daemon/client.js";
import { ensureMacDaemon } from "../daemon/launchd.js";
import { registerDaemonCommands } from "./daemon.js";

vi.mock("../daemon/client.js", () => ({
  daemonIsLive: vi.fn(async () => true),
  daemonRequest: vi.fn(),
}));

vi.mock("../daemon/launchd.js", () => ({
  bootoutMacDaemon: vi.fn(),
  daemonExplicitlyDisabled: vi.fn(() => false),
  ensureMacDaemon: vi.fn(),
  getLaunchdService: vi.fn(),
  setDaemonExplicitlyDisabled: vi.fn(),
  withDaemonLifecycleLock: vi.fn(async (operation: () => Promise<unknown>) => operation()),
}));

vi.mock("../lib/activation.js", () => ({
  decisionIngestionStatus: vi.fn(() => "enabled"),
  repositoryBindingState: vi.fn(),
}));

const mockDaemonRequest = vi.mocked(daemonRequest);
const mockEnsureMacDaemon = vi.mocked(ensureMacDaemon);

const DAY_MS = 86_400_000;
const EXIT_NOT_RUNNING = 2;
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

function snapshot(overrides: Record<string, unknown> = {}) {
  return {
    pid: 4242,
    uptimeMs: 1_000,
    sessionId: "daemon-4242",
    version: "1.2.3",
    healthy: true,
    needsReauth: false,
    heartbeat: { healthy: true, consecutiveFailures: 0 },
    ingestion: healthyIngestion,
    ...overrides,
  };
}

function backlogSnapshot(ingestion: Record<string, unknown> = {}) {
  return snapshot({
    healthy: false,
    ingestion: {
      ...healthyIngestion,
      healthy: false,
      pendingCount: 1200,
      pendingSampled: true,
      oldestPendingAt: Date.now() - 52 * DAY_MS - 60_000,
      ...ingestion,
    },
  });
}

function runningResult(action: "none" | "bootstrap" | "kickstart" = "bootstrap") {
  return {
    state: "running" as const,
    action,
    runtimeChanged: false,
    plistChanged: false,
    responding: true,
    service: { loaded: true as const, pid: 4242 },
    runtime: { manifest: { version: "1.2.3" } },
  } as unknown as Awaited<ReturnType<typeof ensureMacDaemon>>;
}

async function run(argv: string[]): Promise<{ stderr: string; json: Record<string, unknown> }> {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);
  try {
    const program = new Command();
    registerDaemonCommands(program);
    const parsed = program.parseAsync(argv, { from: "user" });
    // Not-ready daemons are polled to the 30s readiness deadline.
    await vi.advanceTimersByTimeAsync(31_000);
    await parsed;
    return {
      stderr: stderr.mock.calls.map(([chunk]) => String(chunk)).join(""),
      json: JSON.parse(String(stdout.mock.calls.at(-1)?.[0])) as Record<string, unknown>,
    };
  } finally {
    stderr.mockRestore();
    stdout.mockRestore();
  }
}

describe("macOS daemon start readiness", () => {
  const platform = Object.getOwnPropertyDescriptor(process, "platform");

  beforeEach(() => {
    Object.defineProperty(process, "platform", { ...platform, value: "darwin" });
    vi.useFakeTimers({ now: 1_800_000_000_000 });
    mockDaemonRequest.mockReset();
    mockEnsureMacDaemon.mockReset();
    mockEnsureMacDaemon.mockResolvedValue(runningResult());
    process.exitCode = undefined;
  });

  afterEach(() => {
    vi.useRealTimers();
    if (platform) Object.defineProperty(process, "platform", platform);
    process.exitCode = undefined;
  });

  it("keeps a fully healthy start's line and JSON byte-compatible", async () => {
    mockDaemonRequest.mockResolvedValue(snapshot());

    const { stderr, json } = await run(["daemon", "start"]);

    expect(stderr).toBe(
      "[prim] ✓ daemon started under launchd (pid=4242) · Decision ingestion enabled\n",
    );
    expect(json).toEqual({
      started: true,
      supervised: true,
      action: "bootstrap",
      pid: 4242,
      loaded: true,
      responding: true,
      healthy: true,
      version: "1.2.3",
      expectedVersion: "1.2.3",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("succeeds with a distinct draining line once the heartbeat is healthy", async () => {
    const draining = backlogSnapshot();
    mockDaemonRequest.mockResolvedValue(draining);

    const { stderr, json } = await run(["daemon", "start"]);

    expect(stderr).toBe(
      "[prim] ✓ daemon started under launchd (pid=4242) · Decision ingestion enabled · draining at least 1200 pending moves (oldest ≥ 52d) in the background\n",
    );
    // Additive only: every pre-existing key keeps its meaning and the exit
    // code still agrees with `started`/`healthy`.
    expect(json).toEqual({
      started: true,
      supervised: true,
      action: "bootstrap",
      pid: 4242,
      loaded: true,
      responding: true,
      healthy: true,
      draining: true,
      ingestion: draining.ingestion,
      version: "1.2.3",
      expectedVersion: "1.2.3",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("starts without gating on delivery, but labels recorded failures as failing", async () => {
    // Start's readiness is the heartbeat (auth + connectivity); delivery is
    // reported, not gated, so a failing drain still starts, with a warning.
    const failing = backlogSnapshot({
      consecutiveFailures: 4,
      lastError: "HTTP 504 from /api/cli/moves",
    });
    mockDaemonRequest.mockResolvedValue(failing);

    const { stderr, json } = await run(["daemon", "restart"]);

    expect(mockEnsureMacDaemon).toHaveBeenCalledWith({
      explicitlyStarted: true,
      forceRestart: true,
    });
    expect(stderr).toBe(
      "[prim] ⚠ daemon started under launchd (pid=4242) · Decision ingestion enabled · delivery failing (4 consecutive failures): HTTP 504 from /api/cli/moves · retrying at least 1200 pending moves (oldest ≥ 52d) in the background\n",
    );
    expect(stderr).not.toContain("draining");
    expect(json).toEqual({
      started: true,
      supervised: true,
      action: "bootstrap",
      pid: 4242,
      loaded: true,
      responding: true,
      healthy: true,
      draining: false,
      deliveryFailing: true,
      ingestion: failing.ingestion,
      version: "1.2.3",
      expectedVersion: "1.2.3",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("starts with a warning, never draining, while the daemon holds buckets back", async () => {
    // The sweep returned without throwing, so no failure is recorded, but the
    // retained Moves cannot deliver until someone acts: start reports that
    // accurately and leaves setup's doctor to fail on the retained buckets.
    const retained = backlogSnapshot({
      lastAcknowledgedCount: 0,
      lastRetainedBucketCount: 1,
      lastRetainedReasons: "unbound:1",
    });
    mockDaemonRequest.mockResolvedValue(retained);

    const { stderr, json } = await run(["daemon", "start"]);

    expect(stderr).toBe(
      "[prim] ⚠ daemon started under launchd (pid=4242) · Decision ingestion enabled · delivery held back: 1 journal bucket retained (unbound:1) · holding at least 1200 pending moves (oldest ≥ 52d) — run `prim doctor`\n",
    );
    expect(stderr).not.toContain("draining");
    expect(json).toEqual({
      started: true,
      supervised: true,
      action: "bootstrap",
      pid: 4242,
      loaded: true,
      responding: true,
      healthy: true,
      draining: false,
      deliveryRetained: true,
      ingestion: retained.ingestion,
      version: "1.2.3",
      expectedVersion: "1.2.3",
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("reports draining when the failed drain acknowledged Moves before it failed", async () => {
    const advancing = backlogSnapshot({
      consecutiveFailures: 1,
      lastAcknowledgedCount: 500,
      lastFailedDrainAcknowledgedCount: 500,
      lastError: "HTTP 503",
    });
    mockDaemonRequest.mockResolvedValue(advancing);

    const { stderr, json } = await run(["daemon", "start"]);

    expect(stderr).toBe(
      "[prim] ✓ daemon started under launchd (pid=4242) · Decision ingestion enabled · draining at least 1200 pending moves (oldest ≥ 52d) in the background\n",
    );
    expect(json).toMatchObject({ started: true, draining: true });
    expect(json).not.toHaveProperty("deliveryFailing");
  });

  it("warns that delivery is failing when only another bucket delivered before the failure", async () => {
    // The sweep total counts every bucket; the drain that failed delivered
    // nothing, so this failure is not advancing.
    const stuck = backlogSnapshot({
      consecutiveFailures: 2,
      lastAcknowledgedCount: 500,
      lastFailedDrainAcknowledgedCount: 0,
      lastError: "HTTP 500",
    });
    mockDaemonRequest.mockResolvedValue(stuck);

    const { stderr, json } = await run(["daemon", "start"]);

    expect(stderr).toBe(
      "[prim] ⚠ daemon started under launchd (pid=4242) · Decision ingestion enabled · delivery failing (2 consecutive failures): HTTP 500 · retrying at least 1200 pending moves (oldest ≥ 52d) in the background\n",
    );
    expect(json).toMatchObject({ started: true, draining: false, deliveryFailing: true });
  });

  it.each([
    ["terminal auth", { needsReauth: true }, "authentication requires `prim auth login`"],
    [
      "an unhealthy heartbeat",
      { heartbeat: { healthy: false, consecutiveFailures: 3, lastError: "HTTP 503" } },
      "heartbeat unhealthy: HTTP 503",
    ],
    ["version skew", { version: "1.2.2" }, "daemon reports v1.2.2, expected v1.2.3"],
  ])("still fails %s while a backlog is pending", async (_label, overrides, reason) => {
    mockDaemonRequest.mockResolvedValue({ ...backlogSnapshot(), ...overrides });

    const { stderr, json } = await run(["daemon", "start"]);

    expect(stderr).toContain(
      "[prim] ✗ launchd daemon did not reach a healthy heartbeat on the expected version",
    );
    expect(stderr).toContain(reason);
    expect(stderr).not.toContain("draining");
    expect(json).toMatchObject({ started: false, healthy: false, state: "degraded" });
    expect(json).not.toHaveProperty("draining");
    expect(process.exitCode).toBe(EXIT_NOT_RUNNING);
  });

  it("fails when launchd does not converge, without probing the socket", async () => {
    mockEnsureMacDaemon.mockResolvedValue({
      ...runningResult(),
      state: "unhealthy",
    } as Awaited<ReturnType<typeof ensureMacDaemon>>);

    const { stderr, json } = await run(["daemon", "start"]);

    expect(mockDaemonRequest).not.toHaveBeenCalled();
    // Nothing was polled, so the line must not blame a heartbeat or version.
    expect(stderr).toContain("[prim] ✗ launchd did not converge on the desired daemon (bootstrap)");
    expect(stderr).not.toContain("heartbeat");
    expect(json).toMatchObject({ started: false, healthy: false, state: "degraded" });
    expect(process.exitCode).toBe(EXIT_NOT_RUNNING);
  });

  it("reports an ensured daemon that is draining, with additive JSON", async () => {
    const draining = backlogSnapshot();
    mockEnsureMacDaemon.mockResolvedValue(runningResult("none"));
    mockDaemonRequest.mockResolvedValue(draining);

    const { stderr, json } = await run(["daemon", "ensure"]);

    expect(stderr).toBe(
      "[prim] ✓ daemon ensured under launchd (none) · Decision ingestion enabled · draining at least 1200 pending moves (oldest ≥ 52d) in the background\n",
    );
    expect(json).toEqual({
      ensured: true,
      disabled: false,
      supervised: true,
      action: "none",
      draining: true,
      ingestion: draining.ingestion,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("reports an ensured daemon whose delivery is failing as failing, not draining", async () => {
    const failing = backlogSnapshot({ consecutiveFailures: 2, lastError: "HTTP 400" });
    mockEnsureMacDaemon.mockResolvedValue(runningResult("none"));
    mockDaemonRequest.mockResolvedValue(failing);

    const { stderr, json } = await run(["daemon", "ensure"]);

    expect(stderr).toBe(
      "[prim] ⚠ daemon ensured under launchd (none) · Decision ingestion enabled · delivery failing (2 consecutive failures): HTTP 400 · retrying at least 1200 pending moves (oldest ≥ 52d) in the background\n",
    );
    expect(json).toEqual({
      ensured: true,
      disabled: false,
      supervised: true,
      action: "none",
      draining: false,
      deliveryFailing: true,
      ingestion: failing.ingestion,
    });
    expect(process.exitCode).toBeUndefined();
  });

  it("keeps a healthy ensure's JSON unchanged", async () => {
    mockEnsureMacDaemon.mockResolvedValue(runningResult("none"));
    mockDaemonRequest.mockResolvedValue(snapshot());

    const { json } = await run(["daemon", "ensure"]);

    expect(json).toEqual({ ensured: true, disabled: false, supervised: true, action: "none" });
  });
});
