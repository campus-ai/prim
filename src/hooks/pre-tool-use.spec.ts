/**
 * PreToolUse entrypoint — through-the-wire coverage of the Codex context
 * composition. The scoring/normalize/appendCodexContext layers run REAL so
 * these tests pin the emitted JSON, not mock choreography; only the process
 * boundaries (argv agent, stdin, stdout, network preflight, repo state, the
 * context preparer) are stubbed. Each test re-imports the module because the
 * entrypoint resolves its agent and runs main() at import time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  isRepoActive: vi.fn(),
  parseAgent: vi.fn(),
  prepareCodexContext: vi.fn(),
  repoSyncId: vi.fn(),
  requestPreflight: vi.fn(),
  resolvePreflightTargets: vi.fn(),
  resultForPreflight: vi.fn(),
}));

vi.mock("../lib/activation.js", () => ({
  isRepoActive: mocks.isRepoActive,
  repoSyncId: mocks.repoSyncId,
}));
vi.mock("../lib/bin-path.js", () => ({ packageVersion: vi.fn(() => "1.2.3") }));
vi.mock("./agent.js", () => ({ parseAgent: mocks.parseAgent }));
vi.mock("./codex-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-context.js")>();
  return { ...actual, prepareCodexContext: mocks.prepareCodexContext };
});
vi.mock("./preflight-v3.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./preflight-v3.js")>();
  return {
    ...actual,
    requestPreflight: mocks.requestPreflight,
    resolvePreflightTargets: mocks.resolvePreflightTargets,
    resultForPreflight: mocks.resultForPreflight,
  };
});

const ENVELOPE = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "session-1",
  tool_name: "apply_patch",
  tool_use_id: "call-1",
  tool_input: { patch: "diff" },
  cwd: "/repo",
});

const HERMES_ENVELOPE = JSON.stringify({
  hook_event_name: "PreToolUse",
  session_id: "session-1",
  tool_name: "apply_patch",
  extra: { tool_call_id: "call-1" },
  tool_input: { patch: "diff" },
  cwd: "/repo",
});

const DIGEST = "[prim] Decisions captured since last message: Nia — “Retry an unavailable feed”";
const DISCLOSURE = "[primitive] hidden Decision: prim decisions show decision-hidden-1";

// A complete ConflictCheckResult — the scoring renderers run REAL here and
// dereference reason/additionalContext/truncated unconditionally.
function conflictResult(
  verdict: string,
  reason = "",
  additionalContext = "",
): Record<string, unknown> {
  return { verdict, conflicts: [], reason, additionalContext, truncated: false };
}

let writes: string[] = [];

function mockStdin(payload: string): void {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  vi.spyOn(process.stdin, "on").mockImplementation(((event: string, listener: () => void) => {
    handlers.set(event, listener);
    if (event === "error") {
      queueMicrotask(() => {
        handlers.get("data")?.(Buffer.from(payload));
        handlers.get("end")?.();
      });
    }
    return process.stdin;
  }) as typeof process.stdin.on);
}

async function runHook(payload = ENVELOPE): Promise<Record<string, unknown>> {
  mockStdin(payload);
  await import("./pre-tool-use.js");
  await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
  return JSON.parse(writes[0]) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetModules();
  writes = [];
  vi.stubEnv("PRIM_HOOK_MODE", "enforce");
  mocks.parseAgent.mockReturnValue("codex");
  mocks.isRepoActive.mockReturnValue(true);
  mocks.repoSyncId.mockReturnValue("sync-1");
  mocks.resolvePreflightTargets.mockReturnValue({
    mutation: "edit",
    paths: ["src/a.ts"],
    coverage: "full",
  });
  mocks.requestPreflight.mockResolvedValue({ ok: true });
  vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    callback?: (error?: Error | null) => void,
  ) => {
    writes.push(String(chunk));
    callback?.();
    return true;
  }) as typeof process.stdout.write);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("PreToolUse entrypoint (codex)", () => {
  it("carries status context beside a deny without touching the enforcement fields", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    mocks.resultForPreflight.mockReturnValue(
      conflictResult("deny", "Keep the Primitive invariant"),
    );
    mocks.prepareCodexContext.mockResolvedValue({
      context: DIGEST,
      feedAvailable: true,
      acknowledge,
    });

    const output = await runHook();

    expect(mocks.prepareCodexContext).toHaveBeenCalledWith({
      cwd: "/repo",
      sessionId: "session-1",
      includeDigest: false,
    });
    expect(output.systemMessage).toBe(DIGEST);
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
    });
    expect(
      (output.hookSpecificOutput as { permissionDecisionReason?: string }).permissionDecisionReason,
    ).toContain("Keep the Primitive invariant");
    expect(acknowledge).toHaveBeenCalledWith(true);
    expect(writes).toHaveLength(1);
  });

  it("stays silent on a clean allow — no digest, no context preparation", async () => {
    mocks.resultForPreflight.mockReturnValue(conflictResult("allow"));

    const output = await runHook();

    expect(output).toEqual({});
    expect(mocks.prepareCodexContext).not.toHaveBeenCalled();
    // {} is byte-identical to codex fail-open; only pipeline progress proves
    // this was a real verdict, not a crashed main() falling open.
    expect(mocks.requestPreflight).toHaveBeenCalledTimes(1);
    expect(mocks.resultForPreflight).toHaveBeenCalledTimes(1);
  });

  it("surfaces hidden Decision disclosures even on a clean allow", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    mocks.resultForPreflight.mockReturnValue(conflictResult("allow", "", DISCLOSURE));
    mocks.prepareCodexContext.mockResolvedValue({
      context: undefined,
      feedAvailable: true,
      acknowledge,
    });

    const output = await runHook();

    expect(output.systemMessage).toBe(DISCLOSURE);
    expect(output.hookSpecificOutput).toMatchObject({
      hookEventName: "PreToolUse",
      additionalContext: DISCLOSURE,
    });
    expect(mocks.prepareCodexContext).toHaveBeenCalledWith({
      cwd: "/repo",
      sessionId: "session-1",
      includeDigest: false,
    });
    expect(acknowledge).toHaveBeenCalledWith(true);
  });

  it("appends status context to the visible unverified notice", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    mocks.resolvePreflightTargets.mockReturnValue({
      mutation: "edit",
      paths: [],
      coverage: "none",
    });
    mocks.prepareCodexContext.mockResolvedValue({
      context: DIGEST,
      feedAvailable: true,
      acknowledge,
    });

    const output = await runHook();

    const systemMessage = output.systemMessage as string;
    expect(systemMessage).toContain("mutation targets could not be determined");
    expect(systemMessage.endsWith(DIGEST)).toBe(true);
    const hookSpecific = output.hookSpecificOutput as { additionalContext?: string };
    expect(hookSpecific.additionalContext).not.toContain(DIGEST);
    expect(acknowledge).toHaveBeenCalledWith(true);
  });

  it("falls back to the plain verdict when context preparation throws", async () => {
    mocks.resultForPreflight.mockReturnValue(
      conflictResult("deny", "Keep the Primitive invariant"),
    );
    mocks.prepareCodexContext.mockRejectedValue(new Error("state dir unreadable"));

    const output = await runHook();

    expect(output.systemMessage).toBeUndefined();
    expect(output.hookSpecificOutput).toMatchObject({ permissionDecision: "deny" });
    expect(writes).toHaveLength(1);
  });
});

describe("PreToolUse entrypoint (claude_code)", () => {
  it("keeps the Claude clean-allow contract byte-identical and out of the codex path", async () => {
    mocks.parseAgent.mockReturnValue("claude_code");
    mocks.resultForPreflight.mockReturnValue(conflictResult("allow"));

    const output = await runHook();

    expect(output).toEqual({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
    });
    expect(mocks.prepareCodexContext).not.toHaveBeenCalled();
    // The allow object is byte-identical to Claude fail-open; pipeline
    // progress distinguishes a real verdict from a crashed main().
    expect(mocks.requestPreflight).toHaveBeenCalledTimes(1);
    expect(mocks.resultForPreflight).toHaveBeenCalledTimes(1);
  });

  it("adds hidden Decision disclosures to an allow without changing permission", async () => {
    mocks.parseAgent.mockReturnValue("claude_code");
    mocks.resultForPreflight.mockReturnValue(conflictResult("allow", "", DISCLOSURE));

    const output = await runHook();

    expect(output.systemMessage).toBe(DISCLOSURE);
    expect(output.hookSpecificOutput).toEqual({
      hookEventName: "PreToolUse",
      permissionDecision: "allow",
      additionalContext: DISCLOSURE,
    });
    expect(mocks.prepareCodexContext).not.toHaveBeenCalled();
  });
});

describe("PreToolUse entrypoint (hermes)", () => {
  it("writes an allow disclosure to stderr while stdout remains an empty object", async () => {
    mocks.parseAgent.mockReturnValue("hermes");
    mocks.resultForPreflight.mockReturnValue(conflictResult("allow", "", DISCLOSURE));
    const stderr: string[] = [];
    vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    }) as typeof process.stderr.write);

    const output = await runHook(HERMES_ENVELOPE);

    expect(output).toEqual({});
    expect(stderr).toEqual([`${DISCLOSURE}\n`]);
    expect(mocks.requestPreflight).toHaveBeenCalledTimes(1);
    expect(mocks.prepareCodexContext).not.toHaveBeenCalled();
  });
});
