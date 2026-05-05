import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";
import {
  type AffectedContext,
  type ServerSpecMapping,
  type SyncDeps,
  findAffectedContexts,
  matchPattern,
  syncAffectedSpecs,
} from "./pre-commit.js";

// ---------------------------------------------------------------------------
// matchPattern
// ---------------------------------------------------------------------------

describe("matchPattern", () => {
  it("matches exact file path", () => {
    expect(matchPattern("src/index.ts", "src/index.ts")).toBe(true);
  });

  it("rejects non-matching exact path", () => {
    expect(matchPattern("src/other.ts", "src/index.ts")).toBe(false);
  });

  it("matches single-level wildcard", () => {
    expect(matchPattern("src/index.ts", "src/*.ts")).toBe(true);
  });

  it("single wildcard does not cross directories", () => {
    expect(matchPattern("src/commands/auth.ts", "src/*.ts")).toBe(false);
  });

  it("matches globstar across directories", () => {
    expect(matchPattern("src/commands/auth.ts", "src/**")).toBe(true);
  });

  it("matches globstar with extension filter", () => {
    expect(matchPattern("src/hooks/pre-commit.ts", "src/**/*.ts")).toBe(true);
  });

  it("rejects file outside pattern scope", () => {
    expect(matchPattern("lib/utils.ts", "src/**")).toBe(false);
  });

  it("handles pattern with no wildcards at root", () => {
    expect(matchPattern("README.md", "README.md")).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// findAffectedContexts
// ---------------------------------------------------------------------------

describe("findAffectedContexts", () => {
  const specs: ServerSpecMapping[] = [
    { _id: "spec-auth", name: "Auth", filePatterns: ["src/commands/auth.*"] },
    { _id: "spec-hooks", name: "Hooks", filePatterns: ["src/hooks/**"] },
    { _id: "spec-all", name: "All", filePatterns: ["src/**"] },
  ];

  it("returns matching spec with affected files", () => {
    const result = findAffectedContexts(["src/hooks/pre-commit.ts"], specs);

    expect(result.has("spec-hooks")).toBe(true);
    expect(result.get("spec-hooks")?.matchedFiles).toEqual(["src/hooks/pre-commit.ts"]);
  });

  it("matches a file to multiple specs", () => {
    const result = findAffectedContexts(["src/hooks/pre-commit.ts"], specs);

    expect(result.has("spec-hooks")).toBe(true);
    expect(result.has("spec-all")).toBe(true);
  });

  it("groups multiple files under the same spec", () => {
    const result = findAffectedContexts(
      ["src/hooks/pre-commit.ts", "src/hooks/post-merge.ts"],
      specs,
    );

    expect(result.get("spec-hooks")?.matchedFiles).toEqual([
      "src/hooks/pre-commit.ts",
      "src/hooks/post-merge.ts",
    ]);
  });

  it("returns empty map when no files match any spec", () => {
    const result = findAffectedContexts(["README.md"], specs);
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty staged files", () => {
    const result = findAffectedContexts([], specs);
    expect(result.size).toBe(0);
  });

  it("returns empty map for empty spec list", () => {
    const result = findAffectedContexts(["src/index.ts"], []);
    expect(result.size).toBe(0);
  });

  it("handles spec with empty filePatterns array", () => {
    const emptySpec: ServerSpecMapping[] = [{ _id: "spec-empty", name: "Empty", filePatterns: [] }];
    const result = findAffectedContexts(["src/index.ts"], emptySpec);
    expect(result.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// syncAffectedSpecs — helpers
// ---------------------------------------------------------------------------

function makeMockClient(overrides?: {
  get?: (path: string, opts?: unknown) => Promise<unknown>;
  post?: (path: string, body?: unknown, opts?: unknown) => Promise<unknown>;
}): CliClient {
  return {
    get: overrides?.get ?? vi.fn(),
    post: overrides?.post ?? vi.fn(async () => ({ analyzing: true })),
    patch: vi.fn(),
    delete: vi.fn(),
  };
}

function makeDeps(overrides?: Partial<SyncDeps>): SyncDeps {
  return {
    getClient: overrides?.getClient ?? (() => makeMockClient()),
    getStagedFiles: overrides?.getStagedFiles ?? (() => []),
    getStagedDiff: overrides?.getStagedDiff ?? (() => "diff --git a/file ..."),
    getGitContext:
      overrides?.getGitContext ??
      (() => ({ branch: null, sha: null, repoFullName: null, prNumber: null })),
    ...overrides,
  };
}

const SPEC_MAPPING: ServerSpecMapping = {
  _id: "ctx-123",
  name: "My Spec",
  filePatterns: ["src/commands/**"],
};

const SPEC_CONTEXT_RESPONSE = {
  _id: "ctx-123",
  name: "My Spec",
  isSpecDocument: true,
};

// ---------------------------------------------------------------------------
// syncAffectedSpecs — happy path
// ---------------------------------------------------------------------------

describe("syncAffectedSpecs — happy path", () => {
  let mockPost: ReturnType<typeof vi.fn>;
  let mockGet: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockPost = vi.fn(async () => ({ analyzing: true }));
    mockGet = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      if (path.includes("/contexts/ctx-123")) return SPEC_CONTEXT_RESPONSE;
      return {};
    });
  });

  it("calls sync-diff with diff content and affected files", async () => {
    const deps = makeDeps({
      getClient: () => makeMockClient({ get: mockGet, post: mockPost }),
      getStagedFiles: () => ["src/commands/hello.ts"],
      getStagedDiff: () => "+console.log('hello');",
    });

    await syncAffectedSpecs(deps);

    expect(mockPost).toHaveBeenCalledWith(
      "/api/cli/contexts/ctx-123/sync-diff",
      {
        diffContent: "+console.log('hello');",
        affectedFiles: ["src/commands/hello.ts"],
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("returns list of synced context IDs", async () => {
    const deps = makeDeps({
      getClient: () => makeMockClient({ get: mockGet, post: mockPost }),
      getStagedFiles: () => ["src/commands/hello.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual(["ctx-123"]);
  });

  it("syncs multiple specs when files match different patterns", async () => {
    const mappings: ServerSpecMapping[] = [
      { _id: "ctx-a", name: "Spec A", filePatterns: ["src/commands/**"] },
      { _id: "ctx-b", name: "Spec B", filePatterns: ["src/hooks/**"] },
    ];

    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return mappings;
      if (path.includes("/contexts/ctx-a"))
        return { _id: "ctx-a", name: "Spec A", isSpecDocument: true };
      if (path.includes("/contexts/ctx-b"))
        return { _id: "ctx-b", name: "Spec B", isSpecDocument: true };
      return {};
    });

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post: mockPost }),
      getStagedFiles: () => ["src/commands/hello.ts", "src/hooks/pre-commit.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toHaveLength(2);
    expect(result).toContain("ctx-a");
    expect(result).toContain("ctx-b");
    expect(mockPost).toHaveBeenCalledTimes(2);
  });

  it("passes only the matched files for each spec in the diff", async () => {
    const deps = makeDeps({
      getClient: () => makeMockClient({ get: mockGet, post: mockPost }),
      getStagedFiles: () => ["src/commands/hello.ts", "src/commands/auth.ts"],
      getStagedDiff: (files) => `diff for ${files.join(",")}`,
    });

    await syncAffectedSpecs(deps);

    expect(mockPost).toHaveBeenCalledWith(
      "/api/cli/contexts/ctx-123/sync-diff",
      {
        diffContent: "diff for src/commands/hello.ts,src/commands/auth.ts",
        affectedFiles: ["src/commands/hello.ts", "src/commands/auth.ts"],
      },
      expect.anything(),
    );
  });
});

// ---------------------------------------------------------------------------
// syncAffectedSpecs — skip / bad cases
// ---------------------------------------------------------------------------

describe("syncAffectedSpecs — skip and bad cases", () => {
  it("returns empty when no files are staged", async () => {
    const deps = makeDeps({ getStagedFiles: () => [] });
    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
  });

  it("returns empty when mappings fetch fails", async () => {
    const get = vi.fn(async () => {
      throw new Error("network error");
    });
    const deps = makeDeps({
      getClient: () => makeMockClient({ get }),
      getStagedFiles: () => ["src/commands/hello.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
  });

  it("returns empty when no mappings exist", async () => {
    const get = vi.fn(async () => []);
    const deps = makeDeps({
      getClient: () => makeMockClient({ get }),
      getStagedFiles: () => ["src/commands/hello.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
  });

  it("returns empty when staged files match no specs", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return {};
    });
    const deps = makeDeps({
      getClient: () => makeMockClient({ get }),
      getStagedFiles: () => ["README.md"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
  });

  it("skips context that is not found", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return {}; // no _id field
    });
    const post = vi.fn();

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it("skips context that is not a spec document", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return { _id: "ctx-123", isSpecDocument: false };
    });
    const post = vi.fn();

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it("skips context when staged diff is empty", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return SPEC_CONTEXT_RESPONSE;
    });
    const post = vi.fn();

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
      getStagedDiff: () => "",
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it("continues syncing other specs when one post fails", async () => {
    const mappings: ServerSpecMapping[] = [
      { _id: "ctx-fail", name: "Fail", filePatterns: ["src/commands/**"] },
      { _id: "ctx-ok", name: "OK", filePatterns: ["src/hooks/**"] },
    ];

    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return mappings;
      if (path.includes("ctx-fail")) return { _id: "ctx-fail", name: "Fail", isSpecDocument: true };
      if (path.includes("ctx-ok")) return { _id: "ctx-ok", name: "OK", isSpecDocument: true };
      return {};
    });

    let callCount = 0;
    const post = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("server error");
      return { analyzing: true };
    });

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts", "src/hooks/pre-commit.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual(["ctx-ok"]);
    expect(post).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// syncAffectedSpecs — edge cases
// ---------------------------------------------------------------------------

describe("syncAffectedSpecs — edge cases", () => {
  it("handles a spec with multiple file patterns where only one matches", async () => {
    const mapping: ServerSpecMapping = {
      _id: "ctx-multi",
      name: "Multi",
      filePatterns: ["src/commands/**", "src/hooks/**", "lib/**"],
    };
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [mapping];
      return { _id: "ctx-multi", name: "Multi", isSpecDocument: true };
    });
    const post = vi.fn(async () => ({ analyzing: true }));

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/hooks/pre-commit.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual(["ctx-multi"]);
  });

  it("does not duplicate files when multiple patterns match the same file", async () => {
    const mapping: ServerSpecMapping = {
      _id: "ctx-overlap",
      name: "Overlap",
      filePatterns: ["src/**", "src/commands/**"],
    };
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [mapping];
      return { _id: "ctx-overlap", name: "Overlap", isSpecDocument: true };
    });
    const post = vi.fn(async () => ({ analyzing: true }));

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
      getStagedDiff: (files) => `diff:${files.join(",")}`,
    });

    await syncAffectedSpecs(deps);

    // The file should appear only once due to the `break` after first pattern match
    const call = post.mock.calls[0];
    expect(call[1]).toEqual({
      diffContent: "diff:src/commands/hello.ts",
      affectedFiles: ["src/commands/hello.ts"],
    });
  });

  it("handles context fetch throwing an error gracefully", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      throw new Error("context fetch failed");
    });
    const post = vi.fn();

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });

  it("handles getStagedDiff throwing an error gracefully", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return SPEC_CONTEXT_RESPONSE;
    });
    const post = vi.fn();

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
      getStagedDiff: () => {
        throw new Error("git diff failed");
      },
    });

    const result = await syncAffectedSpecs(deps);
    expect(result).toEqual([]);
    expect(post).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// syncAffectedSpecs — truncation reporting
// ---------------------------------------------------------------------------

describe("syncAffectedSpecs — truncation reporting", () => {
  it("announces truncation when the server clips the diff", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return SPEC_CONTEXT_RESPONSE;
    });
    const post = vi.fn(async () => ({
      analyzing: true,
      truncated: true,
      sizeChars: 524_288,
      limitChars: 262_144,
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
    });

    try {
      const result = await syncAffectedSpecs(deps);
      expect(result).toEqual(["ctx-123"]);
      const synced = logSpy.mock.calls.find((c) => String(c[0]).includes("[synced]"));
      expect(synced?.[0]).toContain("truncated: 512 KiB → 256 KiB analyzed");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("omits truncation suffix when the server reports a full analysis", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return SPEC_CONTEXT_RESPONSE;
    });
    const post = vi.fn(async () => ({
      analyzing: true,
      truncated: false,
      sizeChars: 1024,
      limitChars: 262_144,
    }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
    });

    try {
      await syncAffectedSpecs(deps);
      const synced = logSpy.mock.calls.find((c) => String(c[0]).includes("[synced]"));
      expect(synced?.[0]).not.toContain("truncated");
    } finally {
      logSpy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// syncAffectedSpecs — branch context (mappings filter + link suffix)
// ---------------------------------------------------------------------------

describe("syncAffectedSpecs — branch context", () => {
  it("appends repoFullName and branch params to the mappings URL when both are set", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return SPEC_CONTEXT_RESPONSE;
    });
    const deps = makeDeps({
      getClient: () => makeMockClient({ get }),
      getStagedFiles: () => ["src/commands/hello.ts"],
      getGitContext: () => ({
        branch: "feat/foo",
        sha: "abc123",
        repoFullName: "campus-ai/prim",
        prNumber: 42,
      }),
    });

    await syncAffectedSpecs(deps);

    const mappingsCall = get.mock.calls.find((c) => String(c[0]).includes("/specs/mappings"));
    const url = String(mappingsCall?.[0]);
    expect(url).toContain("repoFullName=campus-ai%2Fprim");
    expect(url).toContain("branch=feat%2Ffoo");
  });

  it("omits params when branch or repoFullName is null", async () => {
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [SPEC_MAPPING];
      return SPEC_CONTEXT_RESPONSE;
    });
    const deps = makeDeps({
      getClient: () => makeMockClient({ get }),
      getStagedFiles: () => ["src/commands/hello.ts"],
      getGitContext: () => ({
        branch: "feat/foo",
        sha: null,
        repoFullName: null,
        prNumber: null,
      }),
    });

    await syncAffectedSpecs(deps);

    expect(get).toHaveBeenCalledWith("/api/cli/specs/mappings", expect.anything());
  });

  it("appends a (linked to <branch> #<pr> <state>) suffix when the spec is linked to the current branch", async () => {
    const linkedMapping: ServerSpecMapping = {
      ...SPEC_MAPPING,
      linkedBranches: [{ branch: "feat/foo", prNumber: 42, prState: "open" }],
    };
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [linkedMapping];
      return SPEC_CONTEXT_RESPONSE;
    });
    const post = vi.fn(async () => ({ analyzing: true }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
      getGitContext: () => ({
        branch: "feat/foo",
        sha: null,
        repoFullName: "campus-ai/prim",
        prNumber: null,
      }),
    });

    try {
      await syncAffectedSpecs(deps);
      const synced = logSpy.mock.calls.find((c) => String(c[0]).includes("[synced]"));
      expect(synced?.[0]).toContain("(linked to feat/foo #42 open)");
    } finally {
      logSpy.mockRestore();
    }
  });

  it("appends an (auto-linking to <branch>) suffix when the spec has no links", async () => {
    const unlinkedMapping: ServerSpecMapping = { ...SPEC_MAPPING, linkedBranches: [] };
    const get = vi.fn(async (path: string) => {
      if (path.includes("/specs/mappings")) return [unlinkedMapping];
      return SPEC_CONTEXT_RESPONSE;
    });
    const post = vi.fn(async () => ({ analyzing: true }));
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    const deps = makeDeps({
      getClient: () => makeMockClient({ get, post }),
      getStagedFiles: () => ["src/commands/hello.ts"],
      getGitContext: () => ({
        branch: "feat/foo",
        sha: null,
        repoFullName: "campus-ai/prim",
        prNumber: null,
      }),
    });

    try {
      await syncAffectedSpecs(deps);
      const synced = logSpy.mock.calls.find((c) => String(c[0]).includes("[synced]"));
      expect(synced?.[0]).toContain("(auto-linking to feat/foo)");
    } finally {
      logSpy.mockRestore();
    }
  });
});
