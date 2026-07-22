import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildHermesOutput, buildHookOutput, demoteForMode } from "./pre-tool-use-scoring.js";
import {
  MAX_PROPOSAL_BYTES,
  parsePreflightResponse,
  proposalFor,
  resolvePreflightTargets,
  resultForPreflight,
} from "./preflight-v3.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "prim-preflight-v3-"));
  execFileSync("git", ["init", "-q", root]);
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "a");
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

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
      buildHookOutput("deny", [result], "codex").hookSpecificOutput.permissionDecisionReason,
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
});
