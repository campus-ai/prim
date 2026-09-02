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
  boundedClientVersion,
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

  it("uses Codex Bash shell analysis with the same literal redirect coverage", () => {
    expect(
      resolvePreflightTargets({
        toolName: "Bash",
        toolInput: { command: "printf x > src/a.ts" },
        agent: "codex",
        cwd: root,
      }),
    ).toEqual({ paths: ["src/a.ts"], coverage: "complete", mutation: "present" });
  });

  it("accepts a raw-string Bash command for Codex", () => {
    expect(
      resolvePreflightTargets({
        toolName: "Bash",
        toolInput: "printf x > src/raw.ts",
        agent: "codex",
        cwd: root,
      }),
    ).toEqual({ paths: ["src/raw.ts"], coverage: "complete", mutation: "present" });
  });

  it("resolves a Codex Bash apply_patch heredoc completely", () => {
    expect(
      resolvePreflightTargets({
        toolName: "Bash",
        toolInput: {
          command: [
            "apply_patch <<'PATCH'",
            "*** Begin Patch",
            "*** Update File: src/a.ts",
            "*** End Patch",
            "PATCH",
          ].join("\n"),
        },
        agent: "codex",
        cwd: root,
      }),
    ).toEqual({ paths: ["src/a.ts"], coverage: "complete", mutation: "present" });
  });

  it("keeps an unparseable Codex Bash envelope non-definite", () => {
    expect(
      resolvePreflightTargets({
        toolName: "Bash",
        toolInput: { command: 42 },
        agent: "codex",
        cwd: root,
      }),
    ).toEqual({ paths: [], coverage: "unverified", mutation: "present" });
  });

  it("marks a recognized but unparseable Codex apply_patch envelope definite", () => {
    expect(
      resolvePreflightTargets({
        toolName: "apply_patch",
        toolInput: { input: 42 },
        agent: "codex",
        cwd: root,
      }),
    ).toEqual({
      paths: [],
      coverage: "unverified",
      mutation: "present",
      definite: true,
    });
  });

  it("keeps unknown Claude Bash work non-definite", () => {
    expect(
      resolvePreflightTargets({
        toolName: "Bash",
        toolInput: { command: "npm run build" },
        agent: "claude_code",
        cwd: root,
      }),
    ).toEqual({ paths: [], coverage: "unverified", mutation: "present" });
  });

  it("marks non-files and outside paths unverified rather than inventing a scope", () => {
    expect(
      resolvePreflightTargets({
        toolName: "Edit",
        toolInput: { file_path: root },
        agent: "claude_code",
        cwd: root,
      }),
    ).toEqual({
      paths: [],
      coverage: "unverified",
      mutation: "present",
      definite: true,
    });
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
      clientMode: "warn",
      clientVersion: "1.2.3",
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
      expect.objectContaining({
        clientMode: "warn",
        clientVersion: "1.2.3",
        invocationId: "invocation-1",
        paths: ["src/a.ts"],
      }),
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
      clientMode: "block",
      clientVersion: "1.2.3",
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

  it("bounds terminal-safe presentation fields without mutating the wire response", () => {
    const message = `warn\u001b]8;;https://example.invalid\u0007link\u001b[2J\r\n\u202e${"x".repeat(300)}`;
    const response = parsePreflightResponse({
      protocolVersion: 3,
      verdict: "warn",
      reasonCode: "conflict",
      message,
      conflicts: [],
      bypassed: [],
    });

    expect(response).not.toBeNull();
    expect(response?.message).toBe(message);
    const result = resultForPreflight(response as NonNullable<typeof response>);
    for (const value of [result.reason, result.additionalContext]) {
      for (const control of ["\u001b", "\u0007", "\r", "\n", "\u202e"]) {
        expect(value).not.toContain(control);
      }
      expect(value.length).toBeLessThanOrEqual(240);
    }

    const unavailable = parsePreflightResponse({
      protocolVersion: 3,
      verdict: "unavailable",
      reasonCode: `service_unavailable\u001b[2J\r\n\u202e${"x".repeat(300)}`,
      message: "\u001b\r\n\u202e",
      conflicts: [],
      bypassed: [],
    });
    expect(unavailable).not.toBeNull();
    const unavailableResult = resultForPreflight(unavailable as NonNullable<typeof unavailable>);
    expect(unavailableResult.unavailable).toMatch(/^service_unavailable\[2J/u);
    expect(unavailableResult.unavailable?.length).toBeLessThanOrEqual(240);
    for (const control of ["\u001b", "\u0007", "\r", "\n", "\u202e"]) {
      expect(unavailableResult.unavailable).not.toContain(control);
    }
  });

  it("surfaces bounded full-ID disclosure commands for every server verdict", () => {
    for (const verdict of ["allow", "warn", "ask", "block", "unavailable"] as const) {
      const response = parsePreflightResponse({
        protocolVersion: 3,
        verdict,
        reasonCode: "checked",
        message: "checked",
        conflicts: [],
        bypassed: [],
        decisionDisclosures: [
          {
            decisionId: "decision-hidden-1",
            shortId: "0123abcd",
            participation: "candidate",
          },
          {
            decisionId: "decision_hidden_2",
            shortId: "4567abcd",
            participation: "reconcile_bypass",
          },
        ],
      });
      expect(response).not.toBeNull();
      const result = resultForPreflight(response as NonNullable<typeof response>);
      expect(result.additionalContext).toBe(
        "[primitive] hidden Decision: prim decisions show decision-hidden-1\n" +
          "[primitive] hidden Decision: prim decisions show decision_hidden_2",
      );
      const aggregate =
        result.verdict === "deny"
          ? "deny"
          : result.verdict === "ask"
            ? "ask"
            : result.verdict === "warn"
              ? "warn"
              : "allow";
      expect(JSON.stringify(buildHookOutput(aggregate, [result]))).toContain(
        "prim decisions show decision-hidden-1",
      );
      expect(JSON.stringify(buildCodexOutput(aggregate, [result]))).toContain(
        "prim decisions show decision_hidden_2",
      );
    }
  });

  it("keeps an old response without disclosures byte-compatible", () => {
    const response = parsePreflightResponse({
      protocolVersion: 3,
      verdict: "allow",
      reasonCode: "semantically_compatible",
      message: "compatible",
      conflicts: [],
      bypassed: [],
    });
    expect(response).not.toBeNull();
    const result = resultForPreflight(response as NonNullable<typeof response>);
    expect(result.additionalContext).toBe("");
    expect(buildHookOutput("allow", [result])).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(buildCodexOutput("allow", [result])).toEqual({});
  });

  it("rejects malformed, duplicate, over-cap, and terminal-injection disclosure refs", () => {
    const response = (decisionDisclosures: unknown) => ({
      protocolVersion: 3,
      verdict: "allow",
      reasonCode: "semantically_compatible",
      message: "compatible",
      conflicts: [],
      bypassed: [],
      decisionDisclosures,
    });
    const valid = {
      decisionId: "decision-hidden-1",
      shortId: "0123abcd",
      participation: "candidate",
    };

    expect(parsePreflightResponse(response([]))).toBeNull();
    expect(parsePreflightResponse(response(Array.from({ length: 17 }, () => valid)))).toBeNull();
    expect(parsePreflightResponse(response([valid, valid]))).toBeNull();
    for (const decisionId of [
      "decision-hidden-1\nallow",
      "decision-hidden-1;echo-pwned",
      "--help",
      `decision-${"a".repeat(129)}`,
      "decision-\u001b[2J",
    ]) {
      expect(parsePreflightResponse(response([{ ...valid, decisionId }]))).toBeNull();
    }
    for (const shortId of ["ABCDEF12", "1234", "1234567\n"]) {
      expect(parsePreflightResponse(response([{ ...valid, shortId }]))).toBeNull();
    }
    for (const participation of ["hidden", "candidate\n"]) {
      expect(parsePreflightResponse(response([{ ...valid, participation }]))).toBeNull();
    }
    expect(
      parsePreflightResponse(response([{ ...valid, unexpected: "hidden detail" }])),
    ).toBeNull();
  });
});

describe("boundedClientVersion", () => {
  it("passes a bounded, safe-charset version through unchanged", () => {
    expect(boundedClientVersion("0.1.0-alpha.63")).toBe("0.1.0-alpha.63");
    expect(boundedClientVersion("x".repeat(32))).toBe("x".repeat(32));
  });

  it("falls back to unknown rather than sending a value the server would drop", () => {
    // Empty, missing, over-length, and out-of-charset versions must never
    // reach the wire as-is — the server treats an invalid clientVersion as an
    // absent annotation, and a clean 'unknown' keeps analytics honest.
    expect(boundedClientVersion(undefined)).toBe("unknown");
    expect(boundedClientVersion("")).toBe("unknown");
    expect(boundedClientVersion("x".repeat(33))).toBe("unknown");
    expect(boundedClientVersion("0.0.0-pr.1234.g1a2b3c4d+ci.20260802")).toBe("unknown");
    expect(boundedClientVersion("bad version")).toBe("unknown");
  });
});
