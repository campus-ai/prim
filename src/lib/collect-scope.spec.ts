import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";
import type { DecisionCollectScopeResponse } from "../contract/cli-http-v1.js";
import { setLocalGitConfigValue } from "./activation.js";
import {
  cachedCollectScopeAdmits,
  collectScopeAdmits,
  fetchAndCacheCollectScope,
  readCachedCollectScope,
  scheduleCollectScopeRefresh,
  writeCachedCollectScope,
} from "./collect-scope.js";

const POLICY = {
  repositories: ["campus-ai/primitive"],
  directories: ["docs"],
  globs: ["src/**/*.test.ts"],
  branches: ["main", "release/*"],
  updatedAt: 1_787_078_400_000,
};

const RESPONSE: DecisionCollectScopeResponse = {
  policy: POLICY,
  collectScopeVersion: POLICY.updatedAt,
  callerIncluded: true,
};

const temporaryDirectories: string[] = [];

function repository(): string {
  const root = mkdtempSync(join(tmpdir(), "prim-collect-scope-"));
  temporaryDirectories.push(root);
  execFileSync("git", ["init", "-q", root]);
  return root;
}

afterEach(() => {
  for (const root of temporaryDirectories.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("collectScopeAdmits", () => {
  it("collects when no policy has been fetched", () => {
    expect(collectScopeAdmits(undefined, {})).toBe(true);
    expect(collectScopeAdmits(null, { paths: [], pathsComplete: false })).toBe(true);
  });

  it("uses the local hook clock with an inclusive start and exclusive end", () => {
    const windowed = { effectiveFrom: 100, effectiveUntil: 200, updatedAt: 1 };

    expect(collectScopeAdmits(windowed, { now: 99 })).toBe(false);
    expect(collectScopeAdmits(windowed, { now: 100 })).toBe(true);
    expect(collectScopeAdmits(windowed, { now: 199 })).toBe(true);
    expect(collectScopeAdmits(windowed, { now: 200 })).toBe(false);
    expect(collectScopeAdmits(windowed, { now: Number.NaN })).toBe(false);
  });

  it("requires every configured dimension and every path in a mixed move", () => {
    const matching = {
      repository: "CAMPUS-AI/PRIMITIVE",
      branch: "main",
      paths: ["docs/guide.md", "src/auth/login.test.ts"],
      pathsComplete: true,
    } as const;
    expect(collectScopeAdmits(POLICY, matching)).toBe(true);
    expect(collectScopeAdmits(POLICY, { ...matching, repository: "other/repo" })).toBe(false);
    expect(collectScopeAdmits(POLICY, { ...matching, branch: "feature/x" })).toBe(false);
    expect(
      collectScopeAdmits(POLICY, {
        ...matching,
        paths: ["docs/guide.md", "src/auth/login.ts"],
      }),
    ).toBe(false);
    expect(collectScopeAdmits(POLICY, { ...matching, paths: ["docs"] })).toBe(false);
  });

  it("fails closed for incomplete path evidence when path rules exist", () => {
    expect(
      collectScopeAdmits(POLICY, {
        repository: "campus-ai/primitive",
        branch: "main",
        paths: ["docs/guide.md"],
        pathsComplete: false,
      }),
    ).toBe(false);
    expect(
      collectScopeAdmits(POLICY, {
        repository: "campus-ai/primitive",
        branch: "main",
        paths: [],
        pathsComplete: true,
      }),
    ).toBe(false);
  });

  it("lets path-less events pass based on repository and branch alone", () => {
    expect(
      collectScopeAdmits(POLICY, {
        repository: "campus-ai/primitive",
        branch: "release/2026.09",
      }),
    ).toBe(true);
    expect(collectScopeAdmits(POLICY, { repository: "campus-ai/primitive" })).toBe(false);
  });

  it("uses branch wildcards that span slash-delimited branch names", () => {
    expect(
      collectScopeAdmits(
        { branches: ["feature/*"], updatedAt: 1 },
        { branch: "feature/collection/scope" },
      ),
    ).toBe(true);
  });

  it("combines the server caller verdict with local agent alternatives", () => {
    const audience = {
      users: [
        { kind: "role" as const, role: "admin" as const },
        { kind: "agent" as const, agent: "codex" as const },
      ],
      updatedAt: 1,
    };

    expect(collectScopeAdmits(audience, { callerIncluded: true })).toBe(true);
    expect(collectScopeAdmits(audience, { callerIncluded: false, agent: "codex" })).toBe(true);
    expect(collectScopeAdmits(audience, { callerIncluded: false, agent: "hermes" })).toBe(false);
  });

  it("fails closed for a non-agent audience when no server caller verdict is available", () => {
    const audience = {
      users: [{ kind: "credential" as const, credential: "service_token" as const }],
      updatedAt: 1,
    };

    expect(collectScopeAdmits(audience, {})).toBe(false);
    expect(collectScopeAdmits(audience, { callerIncluded: true })).toBe(true);
  });
});

describe("collection scope cache", () => {
  it("treats absent keys and explicit none as universal", () => {
    const cwd = repository();
    expect(
      cachedCollectScopeAdmits(cwd, { paths: ["outside/scope.ts"], pathsComplete: false }),
    ).toBe(true);

    setLocalGitConfigValue(cwd, "prim.collectScope", "none");
    setLocalGitConfigValue(cwd, "prim.collectScopeVersion", "0");
    expect(readCachedCollectScope(cwd)).toEqual({ kind: "none", version: 0 });
    expect(cachedCollectScopeAdmits(cwd, { repository: "other/repo" })).toBe(true);
  });

  it("fails closed for malformed cached policy", () => {
    const cwd = repository();
    setLocalGitConfigValue(cwd, "prim.collectScope", "{");
    setLocalGitConfigValue(cwd, "prim.collectScopeVersion", "1");

    expect(readCachedCollectScope(cwd)).toEqual({ kind: "invalid" });
    expect(cachedCollectScopeAdmits(cwd, { repository: "campus-ai/primitive" })).toBe(false);
  });

  it("fails closed for a partial cache record", () => {
    const cwd = repository();
    setLocalGitConfigValue(cwd, "prim.collectScopeVersion", "1");

    expect(readCachedCollectScope(cwd)).toEqual({ kind: "invalid" });
  });

  it("fails closed for an inverted cached effective window", () => {
    const cwd = repository();
    setLocalGitConfigValue(
      cwd,
      "prim.collectScope",
      JSON.stringify({ updatedAt: 1, effectiveFrom: 200, effectiveUntil: 200 }),
    );
    setLocalGitConfigValue(cwd, "prim.collectScopeVersion", "1");

    expect(readCachedCollectScope(cwd)).toEqual({ kind: "invalid" });
    expect(cachedCollectScopeAdmits(cwd, { now: 200 })).toBe(false);
  });

  it("fails closed when a policy and its version do not agree", () => {
    const cwd = repository();
    setLocalGitConfigValue(cwd, "prim.collectScope", JSON.stringify(POLICY));
    setLocalGitConfigValue(cwd, "prim.collectScopeVersion", "1");

    expect(readCachedCollectScope(cwd)).toEqual({ kind: "invalid" });
    expect(() =>
      writeCachedCollectScope(cwd, { ...RESPONSE, collectScopeVersion: POLICY.updatedAt + 1 }),
    ).toThrow("collection scope response version did not match its policy");
  });

  it("writes a validated response and reads it back", () => {
    const cwd = repository();

    expect(writeCachedCollectScope(cwd, RESPONSE)).toEqual({
      kind: "policy",
      policy: POLICY,
      version: POLICY.updatedAt,
    });
    expect(readCachedCollectScope(cwd)).toEqual({
      kind: "policy",
      policy: POLICY,
      version: POLICY.updatedAt,
    });
  });

  it("persists effective-window policy fields alongside its cache version", () => {
    const cwd = repository();
    const policy = { effectiveFrom: 100, effectiveUntil: 200, updatedAt: 101 };

    expect(
      writeCachedCollectScope(cwd, {
        policy,
        collectScopeVersion: policy.updatedAt,
        callerIncluded: true,
      }),
    ).toEqual({
      kind: "policy",
      policy,
      version: policy.updatedAt,
    });
    expect(cachedCollectScopeAdmits(cwd, { now: 100 })).toBe(true);
    expect(cachedCollectScopeAdmits(cwd, { now: 200 })).toBe(false);
  });

  it("persists server caller admission and evaluates only the hook agent locally", () => {
    const cwd = repository();
    const policy = {
      users: [
        { kind: "role" as const, role: "admin" as const },
        { kind: "agent" as const, agent: "codex" as const },
      ],
      updatedAt: 102,
    };

    expect(
      writeCachedCollectScope(cwd, {
        policy,
        collectScopeVersion: policy.updatedAt,
        callerIncluded: false,
      }),
    ).toEqual({
      kind: "policy",
      policy,
      version: policy.updatedAt,
      callerIncluded: false,
    });
    expect(cachedCollectScopeAdmits(cwd, { agent: "codex" })).toBe(true);
    expect(cachedCollectScopeAdmits(cwd, { agent: "hermes" })).toBe(false);
  });

  it("fails closed for an audience cache that lacks a server caller verdict", () => {
    const cwd = repository();
    const policy = {
      users: [{ kind: "role", role: "admin" }],
      updatedAt: 103,
    };
    setLocalGitConfigValue(cwd, "prim.collectScope", JSON.stringify(policy));
    setLocalGitConfigValue(cwd, "prim.collectScopeVersion", String(policy.updatedAt));

    expect(readCachedCollectScope(cwd)).toEqual({ kind: "invalid" });
    expect(cachedCollectScopeAdmits(cwd, { agent: "codex" })).toBe(false);
  });

  it("fetches and caches only a contract-valid response", async () => {
    const cwd = repository();
    const get = vi.fn().mockResolvedValue(RESPONSE);
    const signal = new AbortController().signal;

    await expect(
      fetchAndCacheCollectScope(cwd, {
        getClient: () => ({ get }) as unknown as CliClient,
        signal: () => signal,
        writeCached: writeCachedCollectScope,
      }),
    ).resolves.toEqual({ kind: "policy", policy: POLICY, version: POLICY.updatedAt });
    expect(get).toHaveBeenCalledWith("/api/cli/decisions/collect-scope", { signal });
  });

  it("refreshes in the background when an ingest acknowledgement reports version drift", async () => {
    const fetch = vi.fn().mockResolvedValue(undefined);
    const cwd = `/scope-drift-${String(Date.now())}-${String(Math.random())}`;

    scheduleCollectScopeRefresh(cwd, 2, {
      readCached: () => ({ kind: "none", version: 1 }),
      fetch,
    });

    await vi.waitFor(() => expect(fetch).toHaveBeenCalledWith(cwd));
  });

  it("does not refresh when the acknowledgement matches the cached version", async () => {
    const fetch = vi.fn().mockResolvedValue(undefined);
    const cwd = `/scope-current-${String(Date.now())}-${String(Math.random())}`;

    scheduleCollectScopeRefresh(cwd, 2, {
      readCached: () => ({ kind: "none", version: 2 }),
      fetch,
    });

    await Promise.resolve();
    expect(fetch).not.toHaveBeenCalled();
  });
});
