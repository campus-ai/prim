import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  INGESTION_RETRY_CAP_MS,
  createDaemonHealthState,
  heartbeatRetryDelayMs,
  ingestionRetryDelayMs,
  refreshDaemonHealth,
  writeDaemonHealthState,
} from "./health.js";

describe("daemon health", () => {
  it("becomes healthy only after a fresh heartbeat and within-SLA ingestion", () => {
    const state = createDaemonHealthState("1.2.3", 42, 1_000);
    refreshDaemonHealth(state, 2_000);
    expect(state.healthy).toBe(false);

    state.heartbeat.lastSuccessAt = 2_000;
    refreshDaemonHealth(state, 2_001);
    expect(state.heartbeat.healthy).toBe(true);
    expect(state.ingestion.healthy).toBe(true);
    expect(state.healthy).toBe(true);

    state.ingestion.pendingCount = 1;
    state.ingestion.oldestPendingAt = 2_000;
    refreshDaemonHealth(state, 32_001);
    expect(state.ingestion.healthy).toBe(false);
    expect(state.healthy).toBe(false);
  });

  it("marks a current rejection unhealthy even while the last success is fresh", () => {
    const state = createDaemonHealthState("1.2.3", 42, 1_000);
    state.heartbeat.lastSuccessAt = 2_000;
    state.heartbeat.consecutiveFailures = 1;
    refreshDaemonHealth(state, 2_001);
    expect(state.heartbeat.healthy).toBe(false);
  });

  it("fails closed when a bounded queue sample cannot prove the SLA", () => {
    const state = createDaemonHealthState("1.2.3", 42, 1_000);
    state.heartbeat.lastSuccessAt = 2_000;
    state.ingestion.pendingCount = 1;
    state.ingestion.pendingSampled = true;
    state.ingestion.oldestPendingAt = 1_999;

    refreshDaemonHealth(state, 2_001);
    expect(state.ingestion.healthy).toBe(false);
    expect(state.healthy).toBe(false);
  });

  it("uses five-second exponential retry with jitter capped at the poll cadence", () => {
    expect(ingestionRetryDelayMs(1, () => 0.5)).toBe(5_000);
    expect(ingestionRetryDelayMs(2, () => 0.5)).toBe(10_000);
    expect(ingestionRetryDelayMs(3, () => 1)).toBe(INGESTION_RETRY_CAP_MS);
  });

  it("retries failed heartbeats from five seconds and caps at normal cadence", () => {
    expect(heartbeatRetryDelayMs(1, () => 0.5)).toBe(5_000);
    expect(heartbeatRetryDelayMs(2, () => 0.5)).toBe(10_000);
    expect(heartbeatRetryDelayMs(20, () => 1)).toBe(30_000);
  });
});

describe("health-state persistence", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prim-health-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("atomically writes a 0600 JSON state file", () => {
    const path = join(dir, "nested", "daemon-health.json");
    const state = createDaemonHealthState("1.2.3", 42, 1_000);
    writeDaemonHealthState(state, path);

    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(path, "utf-8"))).toMatchObject({
      schemaVersion: 1,
      version: "1.2.3",
      pid: 42,
    });
  });
});
