/**
 * PostToolUse entrypoint — through-the-wire coverage of the verdict-footer
 * gate and the Codex context emission. The verdict-footer type guard,
 * normalize, and appendCodexContext run REAL; the process boundaries (argv
 * agent, stdin, stdout/stderr, ingest delivery, repo state, the context
 * preparer) are stubbed. Each test re-imports the module because the
 * entrypoint runs main() at import time.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  deliverPostToolMove: vi.fn(),
  enrichHookPayloadWithFileRefs: vi.fn(),
  isRepoActiveForCapture: vi.fn(),
  parseAgent: vi.fn(),
  postToolInvocationId: vi.fn(),
  prepareCodexContext: vi.fn(),
  repoSyncId: vi.fn(),
  resolveOrg: vi.fn(),
  resolveRepositoryContext: vi.fn(),
  toMove: vi.fn(),
  toolOutcomeFor: vi.fn(),
}));

vi.mock("../binding.js", () => ({ resolveOrg: mocks.resolveOrg }));
vi.mock("../lib/activation.js", () => ({
  isRepoActiveForCapture: mocks.isRepoActiveForCapture,
  repoSyncId: mocks.repoSyncId,
}));
vi.mock("../lib/git.js", () => ({ resolveRepositoryContext: mocks.resolveRepositoryContext }));
vi.mock("../lib/workspace-id.js", () => ({
  getOrCreateWorkspaceId: vi.fn(() => ({ status: "not_git" })),
}));
vi.mock("./agent.js", () => ({ parseAgent: mocks.parseAgent }));
vi.mock("./codex-context.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./codex-context.js")>();
  return { ...actual, prepareCodexContext: mocks.prepareCodexContext };
});
vi.mock("./file-refs.js", () => ({
  enrichHookPayloadWithFileRefs: mocks.enrichHookPayloadWithFileRefs,
  preserveHookFileMetadata: vi.fn((scrubbed: unknown) => scrubbed),
}));
vi.mock("./post-tool-delivery.js", () => ({ deliverPostToolMove: mocks.deliverPostToolMove }));
vi.mock("./prim-hook-core.js", () => ({
  postToolInvocationId: mocks.postToolInvocationId,
  toMove: mocks.toMove,
  toolOutcomeFor: mocks.toolOutcomeFor,
}));
vi.mock("./redact.js", () => ({ scrubFromCwd: vi.fn((parsed: unknown) => parsed) }));

const ENVELOPE = JSON.stringify({
  hook_event_name: "PostToolUse",
  session_id: "session-1",
  tool_name: "apply_patch",
  tool_use_id: "call-1",
  tool_input: {},
  cwd: "/repo",
});

const DIGEST = "[prim] Decisions captured since last message: Omar — “Show verdict context”";

const VERDICT_FOOTER = {
  author: "Maya",
  intent: "Keep the invariant",
  decisionsSaved: 2,
  decisionsSavedTruncated: false,
  decisionId: "decision-1",
  decisionShortId: undefined,
};

let writes: string[] = [];
let stderrWrites: string[] = [];

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

async function runHook(): Promise<Record<string, unknown>> {
  mockStdin(ENVELOPE);
  await import("./post-tool-use.js");
  await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));
  return JSON.parse(writes[0]) as Record<string, unknown>;
}

beforeEach(() => {
  vi.resetModules();
  writes = [];
  stderrWrites = [];
  mocks.parseAgent.mockReturnValue("codex");
  mocks.isRepoActiveForCapture.mockReturnValue(true);
  mocks.repoSyncId.mockReturnValue("sync-1");
  mocks.resolveRepositoryContext.mockReturnValue({ repoFullName: "org/repo" });
  mocks.resolveOrg.mockReturnValue({ orgId: "org-1" });
  mocks.postToolInvocationId.mockReturnValue("call-1");
  mocks.toolOutcomeFor.mockReturnValue("completed");
  mocks.toMove.mockReturnValue({
    moveId: "move-1",
    sessionId: "session-1",
    env: { cwd: "/repo" },
    payload: {},
  });
  mocks.enrichHookPayloadWithFileRefs.mockImplementation(({ parsed }: { parsed: unknown }) => ({
    parsed,
    resolution: { shellMutation: undefined, fileRefs: [{ path: "src/a.ts" }] },
  }));
  mocks.deliverPostToolMove.mockResolvedValue({ accepted: true, verdictFooter: null });
  vi.spyOn(process.stdout, "write").mockImplementation(((
    chunk: unknown,
    callback?: (error?: Error | null) => void,
  ) => {
    writes.push(String(chunk));
    callback?.();
    return true;
  }) as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("PostToolUse entrypoint (codex)", () => {
  it("emits status context as systemMessage when the verdict footer fires", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    mocks.deliverPostToolMove.mockResolvedValue({
      accepted: true,
      verdictFooter: VERDICT_FOOTER,
    });
    mocks.prepareCodexContext.mockResolvedValue({
      context: DIGEST,
      feedAvailable: true,
      acknowledge,
    });

    const output = await runHook();

    expect(stderrWrites.join("")).toContain("Conflict caught before merge");
    expect(output).toEqual({ systemMessage: DIGEST });
    expect(mocks.prepareCodexContext).toHaveBeenCalledWith({
      cwd: "/repo",
      sessionId: "session-1",
      includeDigest: false,
    });
    expect(acknowledge).toHaveBeenCalledWith(true);
    expect(writes).toHaveLength(1);
  });

  it("still acknowledges the cursor when nothing new is visible", async () => {
    const acknowledge = vi.fn().mockResolvedValue(undefined);
    mocks.deliverPostToolMove.mockResolvedValue({
      accepted: true,
      verdictFooter: VERDICT_FOOTER,
    });
    mocks.prepareCodexContext.mockResolvedValue({
      context: undefined,
      feedAvailable: true,
      acknowledge,
    });

    const output = await runHook();

    expect(output).toEqual({});
    expect(acknowledge).toHaveBeenCalledWith(true);
  });

  it("keeps ordinary results at exactly {} without preparing context", async () => {
    const output = await runHook();

    expect(output).toEqual({});
    expect(writes[0]).toBe("{}\n");
    expect(mocks.prepareCodexContext).not.toHaveBeenCalled();
    // {} is byte-identical to the catch-all fallback; only a completed
    // delivery proves the ingest path actually ran.
    expect(mocks.deliverPostToolMove).toHaveBeenCalledTimes(1);
  });

  it("keeps the stderr verdict authoritative when context preparation throws", async () => {
    mocks.deliverPostToolMove.mockResolvedValue({
      accepted: true,
      verdictFooter: VERDICT_FOOTER,
    });
    mocks.prepareCodexContext.mockRejectedValue(new Error("state dir unreadable"));

    const output = await runHook();

    expect(stderrWrites.join("")).toContain("Conflict caught before merge");
    expect(output).toEqual({});
    expect(writes).toHaveLength(1);
  });
});

describe("PostToolUse entrypoint (claude_code)", () => {
  it("never routes a Claude verdict footer into the codex context path", async () => {
    mocks.parseAgent.mockReturnValue("claude_code");
    mocks.deliverPostToolMove.mockResolvedValue({
      accepted: true,
      verdictFooter: VERDICT_FOOTER,
    });
    // Claude's editing tools differ; keep the envelope in its set.
    mockStdin(
      JSON.stringify({
        hook_event_name: "PostToolUse",
        session_id: "session-1",
        tool_name: "Edit",
        tool_use_id: "call-1",
        tool_input: {},
        cwd: "/repo",
      }),
    );
    await import("./post-tool-use.js");
    await vi.waitFor(() => expect(writes.length).toBeGreaterThan(0));

    expect(writes[0]).toBe("{}\n");
    expect(stderrWrites.join("")).toContain("Conflict caught before merge");
    expect(mocks.prepareCodexContext).not.toHaveBeenCalled();
  });
});
