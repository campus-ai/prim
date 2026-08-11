import { describe, expect, it, vi } from "vitest";
import {
  STATUSLINE_INGESTION_CACHE_MAX_ENTRIES,
  STATUSLINE_INGESTION_CACHE_TTL_MS,
  StatuslineIngestionCache,
  formatStatusline,
} from "./statusline-render.js";

describe("StatuslineIngestionCache", () => {
  it("uses the bounded production policy", () => {
    expect(STATUSLINE_INGESTION_CACHE_TTL_MS).toBe(30_000);
    expect(STATUSLINE_INGESTION_CACHE_MAX_ENTRIES).toBe(256);
  });

  it("coalesces Git-backed state for 30 seconds and refreshes on expiry", () => {
    let now = 1_000;
    const resolve = vi.fn(() => "enabled" as const);
    const cache = new StatuslineIngestionCache(resolve, () => now);

    expect(cache.get("/repo")).toBe("enabled");
    now += 29_999;
    expect(cache.get("/repo")).toBe("enabled");
    expect(resolve).toHaveBeenCalledOnce();
    now += 1;
    expect(cache.get("/repo")).toBe("enabled");
    expect(resolve).toHaveBeenCalledTimes(2);
  });

  it("is bounded and can be invalidated eagerly", () => {
    const resolve = vi.fn(() => "disabled" as const);
    const cache = new StatuslineIngestionCache(resolve, Date.now, 30_000, 2);

    cache.get("/one");
    cache.get("/two");
    cache.get("/three");
    cache.get("/one");
    expect(resolve).toHaveBeenCalledTimes(4);

    cache.clear();
    cache.get("/one");
    expect(resolve).toHaveBeenCalledTimes(5);
  });
});

describe("formatStatusline I/O boundary", () => {
  it("does not resolve Git-backed state for down or unhealthy snapshots", () => {
    const resolve = vi.fn(() => "enabled" as const);
    expect(formatStatusline("1.2.3", null, resolve)).toContain("daemon: down");
    expect(
      formatStatusline(
        "1.2.3",
        {
          pid: 1,
          uptimeMs: 1,
          sessionId: "session",
          healthy: false,
          heartbeat: { healthy: false },
        },
        resolve,
      ),
    ).toContain("presence: unavailable");
    expect(resolve).not.toHaveBeenCalled();
  });

  it("can include repo ingestion state on every Codex health branch", () => {
    const resolve = vi.fn(() => "enabled" as const);
    expect(
      formatStatusline("1.2.3", null, resolve, { includeIngestionWhenUnavailable: true }),
    ).toBe("primitive 1.2.3 (daemon: down · Decision ingestion enabled)");
    expect(
      formatStatusline(
        "1.2.3",
        {
          pid: 1,
          uptimeMs: 1,
          sessionId: "session",
          healthy: false,
          needsReauth: true,
        },
        resolve,
        { includeIngestionWhenUnavailable: true },
      ),
    ).toBe("primitive 1.2.3 (daemon: paused · run `prim auth login` · Decision ingestion enabled)");
    expect(
      formatStatusline(
        "1.2.3",
        { pid: 1, uptimeMs: 1, sessionId: "session", healthy: false },
        resolve,
        { includeIngestionWhenUnavailable: true },
      ),
    ).toBe("primitive 1.2.3 (daemon: starting · Decision ingestion enabled)");
    expect(
      formatStatusline(
        "1.2.3",
        {
          pid: 1,
          uptimeMs: 1,
          sessionId: "session",
          healthy: false,
          ingestion: { healthy: false, pendingCount: 4 },
        },
        resolve,
        { includeIngestionWhenUnavailable: true },
      ),
    ).toBe(
      "primitive 1.2.3 (daemon: degraded · delivery: stalled · 4 pending · Decision ingestion enabled)",
    );
    expect(
      formatStatusline(
        "1.2.3",
        {
          pid: 1,
          uptimeMs: 1,
          sessionId: "session",
          healthy: false,
          heartbeat: { healthy: false },
        },
        resolve,
        { includeIngestionWhenUnavailable: true },
      ),
    ).toBe(
      "primitive 1.2.3 (daemon: degraded · presence: unavailable · Decision ingestion enabled)",
    );
    expect(resolve).toHaveBeenCalledTimes(5);
  });
});
