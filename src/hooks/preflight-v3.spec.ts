import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockPost } = vi.hoisted(() => ({ mockPost: vi.fn() }));

vi.mock("../client.js", () => ({ getClient: () => ({ post: mockPost }) }));

import {
  buildCodexOutput,
  buildHermesOutput,
  buildHookOutput,
  demoteForMode,
} from "./pre-tool-use-scoring.js";
import {
  MAX_PROPOSAL_BYTES,
  PREFLIGHT_TIMEOUT_MS,
  parsePreflightResponse,
  proposalFor,
  requestPreflight,
  resolvePreflightTargets,
  resultForPreflight,
  unverifiedResult,
} from "./preflight-v3.js";

let root: string;

beforeEach(() => {
  mockPost.mockReset();
  root = mkdtempSync(join(tmpdir(), "prim-preflight-v3-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "a");
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

describe("resolvePreflightTargets", () => {
  it("uses the existing native extractors and exact canonical paths", () => {
    expect(
      resolvePreflightTargets({
        toolName: "NotebookEdit",
        toolInput: { notebook_path: join(root, "src", "book.ipynb") },
        agent: "claude_code",
        cwd: root,
      }),
    ).toEqual({ paths: ["src/book.ipynb"], coverage: "complete", mutation: "present" });

    expect(
      resolvePreflightTargets({
        toolName: "apply_patch",
        toolInput: {
          command: "*** Update File: src/a.ts\n*** Move to: src/b.ts",
        },
        agent: "codex",
        cwd: root,
      }),
    ).toEqual({
      paths: ["src/a.ts", "src/b.ts"],
      coverage: "complete",
      mutation: "present",
    });
  });

  it("keeps known shell targets but marks a dynamic sibling whole-call unverified", () => {
    expect(
      resolvePreflightTargets({
        toolName: "Bash",
        toolInput: { command: 'printf x > src/a.ts; touch "$OUT"' },
        agent: "claude_code",
        cwd: root,
      }),
    ).toEqual({ paths: ["src/a.ts"], coverage: "unverified", mutation: "present" });
  });

  it("marks non-files and outside paths unverified rather than inventing a scope", () => {
    expect(
      resolvePreflightTargets({
        toolName: "Edit",
        toolInput: { file_path: root },
        agent: "claude_code",
        cwd: root,
      }),
    ).toEqual({ paths: [], coverage: "unverified", mutation: "present" });
  });
});

describe("v3 wire helpers", () => {
  it("sends one direct request and accepts a response after six seconds", async () => {
    vi.useFakeTimers();
    mockPost.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          setTimeout(
            () =>
              resolve({
                protocolVersion: 3,
                verdict: "allow",
                reasonCode: "semantically_compatible",
                message: "compatible",
                conflicts: [],
                bypassed: [],
              }),
            6_000,
          );
        }),
    );
    const pending = requestPreflight({
      protocolVersion: 3,
      agent: "claude_code",
      sessionId: "session-1",
      invocationId: "invocation-1",
      repoSyncId: "repo-1",
      paths: ["src/a.ts"],
      coverage: "complete",
      proposal: "compatible edit",
    });

    await vi.advanceTimersByTimeAsync(6_000);

    await expect(pending).resolves.toMatchObject({ verdict: "allow" });
    expect(mockPost).toHaveBeenCalledOnce();
    expect(mockPost).toHaveBeenCalledWith(
      "/api/cli/decisions/conflict-check",
      expect.objectContaining({ invocationId: "invocation-1", paths: ["src/a.ts"] }),
      { signal: expect.any(AbortSignal), quietRefresh: true },
    );
  });

  it("fails open visibly for every host when the direct request reaches its hard deadline", async () => {
    vi.useFakeTimers();
    vi.spyOn(AbortSignal, "timeout").mockImplementationOnce((milliseconds) => {
      expect(milliseconds).toBe(PREFLIGHT_TIMEOUT_MS);
      const controller = new AbortController();
      setTimeout(() => controller.abort(new Error("deadline reached")), milliseconds);
      return controller.signal;
    });
    mockPost.mockImplementationOnce(
      (_path, _request, { signal }: { signal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    const pending = requestPreflight({
      protocolVersion: 3,
      agent: "claude_code",
      sessionId: "session-1",
      invocationId: "invocation-1",
      repoSyncId: "repo-1",
      paths: ["src/a.ts"],
      coverage: "complete",
      proposal: "compatible edit",
    });
    const rejection = expect(pending).rejects.toBeDefined();

    await vi.advanceTimersByTimeAsync(PREFLIGHT_TIMEOUT_MS);
    await rejection;
    expect(mockPost).toHaveBeenCalledOnce();

    const result = unverifiedResult("enforcement service unavailable; change was not verified");
    const claude = buildHookOutput("allow", [result]);
    const codex = buildCodexOutput("allow", [result]);

    expect(claude.systemMessage).toContain("change was not verified");
    expect(claude.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(codex.systemMessage).toContain("change was not verified");
    expect(codex.hookSpecificOutput).not.toHaveProperty("permissionDecision");
    expect(buildHermesOutput("allow", [result])).toEqual({});
    expect(`[primitive] ${result.unavailable}`).toContain("change was not verified");
  });

  it("redacts secrets and bounds the proposal by UTF-8 bytes", () => {
    const proposal = proposalFor({ token: "Bearer abc.def", content: "😀".repeat(5_000) });
    expect(proposal).toContain("<REDACTED:bearer-token>");
    expect(Buffer.byteLength(proposal)).toBeLessThanOrEqual(MAX_PROPOSAL_BYTES);
    expect(proposal).not.toContain("�");
  });

  it("strictly validates v3 and maps block to the existing host renderer contract", () => {
    const response = parsePreflightResponse({
      protocolVersion: 3,
      verdict: "block",
      reasonCode: "conflict",
      message: "reconcile first",
      conflicts: [
        { decisionId: "decision1", shortId: "ab12cd34" },
        { decisionId: "bad; echo injected", shortId: "bad; echo injected" },
      ],
      bypassed: [],
    });
    expect(response).not.toBeNull();
    const result = resultForPreflight(response as NonNullable<typeof response>);
    expect(result).toMatchObject({
      verdict: "deny",
      reason: "reconcile first\nTo reconcile, run: prim reconcile dec_ab12cd34",
    });
    expect(result.reason).not.toContain("injected");
    expect(
      buildCodexOutput("deny", [result]).hookSpecificOutput?.permissionDecisionReason,
    ).toContain("prim reconcile dec_ab12cd34");
    expect(buildHookOutput("ask", [result]).hookSpecificOutput.permissionDecisionReason).toContain(
      "prim reconcile dec_ab12cd34",
    );
    expect(buildHermesOutput("deny", [result]).message).toContain("prim reconcile dec_ab12cd34");
    expect(
      buildHookOutput(demoteForMode("deny", "warn"), [result]).hookSpecificOutput,
    ).toMatchObject({ permissionDecision: "allow", additionalContext: result.reason });
    expect(parsePreflightResponse({ protocolVersion: 2, verdict: "allow" })).toBeNull();
  });

  it("renders unsupported dynamic mutations as directly visible warnings", () => {
    const result = unverifiedResult(
      "mutation targets could not be determined; enforcement not verified",
    );
    const claude = buildHookOutput("allow", [result]);
    const codex = buildCodexOutput("allow", [result]);

    expect(claude.systemMessage).toContain("enforcement not verified");
    expect(claude.hookSpecificOutput.permissionDecision).toBe("allow");
    expect(codex.systemMessage).toContain("enforcement not verified");
    expect(codex.hookSpecificOutput).not.toHaveProperty("permissionDecision");
  });
});
