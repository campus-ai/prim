import { afterEach, describe, expect, it, vi } from "vitest";
import { warmBinCache } from "../lib/bin-cache.js";
import { parseAgent } from "./agent.js";
import { handoffHookOutput } from "./decision-feedback-core.js";
import { processSessionStart } from "./session-start-core.js";

vi.mock("../decisions/feedback.js", () => ({ FEEDBACK_DEADLINE_MS: 3_000 }));
vi.mock("../lib/bin-cache.js", () => ({ warmBinCache: vi.fn() }));
vi.mock("./agent.js", () => ({ parseAgent: vi.fn() }));
vi.mock("./decision-feedback-core.js", () => ({
  buildHookOutput: vi.fn((fields) => fields),
  handoffHookOutput: vi.fn().mockResolvedValue(true),
}));
vi.mock("./session-start-core.js", () => ({ processSessionStart: vi.fn() }));

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SessionStart entrypoint", () => {
  it("starts the feedback deadline before cache warming and stdin collection", async () => {
    const feedbackSignal = new AbortController().signal;
    const timeoutSpy = vi.spyOn(AbortSignal, "timeout").mockReturnValue(feedbackSignal);
    vi.mocked(parseAgent).mockReturnValue("claude_code");
    vi.mocked(processSessionStart).mockResolvedValue({ output: {}, acknowledge: undefined });

    const handlers = new Map<string, (...args: unknown[]) => void>();
    const stdinOnSpy = vi.spyOn(process.stdin, "on").mockImplementation(((
      event: string,
      listener: () => void,
    ) => {
      handlers.set(event, listener);
      if (event === "error") {
        queueMicrotask(() => {
          handlers.get("data")?.(Buffer.from('{"hook_event_name":"SessionStart"}'));
          handlers.get("end")?.();
        });
      }
      return process.stdin;
    }) as typeof process.stdin.on);

    await import("./session-start.js");
    await vi.waitFor(() => expect(handoffHookOutput).toHaveBeenCalledOnce());

    expect(timeoutSpy).toHaveBeenCalledWith(3_000);
    expect(timeoutSpy.mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(warmBinCache).mock.invocationCallOrder[0],
    );
    expect(timeoutSpy.mock.invocationCallOrder[0]).toBeLessThan(
      stdinOnSpy.mock.invocationCallOrder[0],
    );
    expect(processSessionStart).toHaveBeenCalledWith(
      '{"hook_event_name":"SessionStart"}',
      "claude_code",
      feedbackSignal,
    );
  });
});
