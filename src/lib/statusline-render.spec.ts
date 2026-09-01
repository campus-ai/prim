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
    const cache = new StatuslineIngestionCache(resolve, { now: () => now });

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
    const cache = new StatuslineIngestionCache(resolve, { maxEntries: 2 });

    cache.get("/one");
    cache.get("/two");
    cache.get("/three");
    cache.get("/one");
    expect(resolve).toHaveBeenCalledTimes(4);

    cache.clear();
    cache.get("/one");
    expect(resolve).toHaveBeenCalledTimes(5);
  });

  it("co-caches the binding diagnostic only for enabled repositories", () => {
    let enabled = true;
    const resolveBinding = vi.fn(() => "unbound" as const);
    const cache = new StatuslineIngestionCache(() => (enabled ? "enabled" : "disabled"), {
      resolveRepositoryBindingState: resolveBinding,
    });

    expect(cache.get("/enabled")).toBe("enabled");
    expect(cache.getRepositoryBindingState("/enabled")).toBe("unbound");
    expect(resolveBinding).toHaveBeenCalledOnce();

    enabled = false;
    expect(cache.get("/disabled")).toBe("disabled");
    expect(cache.getRepositoryBindingState("/disabled")).toBeUndefined();
    expect(resolveBinding).toHaveBeenCalledOnce();
  });
});

describe("formatStatusline I/O boundary", () => {
  it("surfaces only closed binding-state labels and never caller-provided text", () => {
    const snapshot = {
      pid: 1,
      uptimeMs: 1,
      sessionId: "session",
      healthy: true,
      onlineCount: 1,
    };
    expect(
      formatStatusline("1.2.3", snapshot, () => "enabled", {
        resolveRepositoryBindingState: () => "unbound",
      }),
    ).toContain("GitHub repo connection: required (run `prim github connect`)");

    const forged = "unbound\u001b]52;c;secret\u0007";
    const line = formatStatusline("1.2.3", snapshot, () => "enabled", {
      resolveRepositoryBindingState: () => forged as "unbound",
    });
    expect(line).not.toContain("secret");
    expect(line).not.toContain("\u001b");
    expect(line).not.toContain("repository:");
  });

  it("prioritizes reauth hold without resolving or rendering repository state", () => {
    const resolveBinding = vi.fn(() => "unbound" as const);
    const line = formatStatusline(
      "1.2.3",
      {
        pid: 1,
        uptimeMs: 1,
        sessionId: "session",
        healthy: false,
        needsReauth: true,
      },
      () => "enabled",
      { resolveRepositoryBindingState: resolveBinding },
    );
    expect(line).toContain("prim auth login");
    expect(line).not.toContain("repository:");
    expect(resolveBinding).not.toHaveBeenCalled();
  });

  it("keeps styled Decision links by default and renders them bare under plainLinks", () => {
    const resolve = vi.fn(() => "enabled" as const);
    const snapshot = {
      pid: 1,
      uptimeMs: 1,
      sessionId: "session",
      healthy: true,
      onlineTeammates: [
        {
          name: "Kasey",
          area: "auth",
          decisionUrl: "https://app.getprimitive.ai/decisions/kasey-decision",
        },
      ],
    };

    // The Claude statusline and daemon raw protocol are terminal surfaces —
    // the OSC 8 hyperlink must survive there.
    expect(formatStatusline("1.2.3", snapshot, resolve)).toContain("\x1b]8;;");

    // Hook JSON context fields are not terminals: the same roster must render
    // with zero escape bytes.
    const plain = formatStatusline("1.2.3", snapshot, resolve, { plainLinks: true });
    expect(plain).toBe(
      "primitive 1.2.3 (daemon: live, Decision ingestion enabled · team: Kasey - auth)",
    );
    // biome-ignore lint/suspicious/noControlCharactersInRegex: asserting escape-byte absence.
    expect(plain).not.toMatch(/[\x1b\x07]/u);
  });

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
