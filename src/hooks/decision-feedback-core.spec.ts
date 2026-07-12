import { describe, expect, it } from "vitest";
import { buildHookOutput, handoffHookOutput, writeHookOutput } from "./decision-feedback-core.js";

class FakeOutput {
  chunks: string[] = [];
  callback: ((error?: Error | null) => void) | undefined;
  errorListener: ((error: Error) => void) | undefined;

  once(_event: "error", listener: (error: Error) => void): void {
    this.errorListener = listener;
  }

  off(_event: "error", listener: (error: Error) => void): void {
    if (this.errorListener === listener) this.errorListener = undefined;
  }

  write(chunk: string, callback: (error?: Error | null) => void): boolean {
    this.chunks.push(chunk);
    this.callback = callback;
    return true;
  }
}

describe("buildHookOutput", () => {
  it("keeps feedback human-visible and preserves Codex context independently", () => {
    expect(buildHookOutput({ systemMessage: "feedback" })).toEqual({
      systemMessage: "feedback",
    });
    expect(buildHookOutput({ additionalContext: "presence" })).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: "presence",
      },
    });
    expect(buildHookOutput({})).toEqual({});
  });
});

describe("writeHookOutput", () => {
  it("does not report success before the stdout callback", async () => {
    const stream = new FakeOutput();
    let resolved = false;
    const pending = writeHookOutput({ systemMessage: "safe" }, stream).then((value) => {
      resolved = true;
      return value;
    });
    await Promise.resolve();
    expect(resolved).toBe(false);
    expect(stream.chunks).toEqual(['{"systemMessage":"safe"}\n']);
    stream.callback?.();
    await expect(pending).resolves.toBe(true);
  });

  it("reports EPIPE-like stream errors as an unsuccessful handoff", async () => {
    const stream = new FakeOutput();
    const pending = writeHookOutput({}, stream);
    stream.errorListener?.(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await expect(pending).resolves.toBe(false);
  });

  it("retains the error listener when callback error precedes the EPIPE event", async () => {
    const stream = new FakeOutput();
    const pending = writeHookOutput({}, stream);
    const listener = stream.errorListener;
    stream.callback?.(Object.assign(new Error("broken pipe"), { code: "EPIPE" }));
    await expect(pending).resolves.toBe(false);
    expect(listener).toBeDefined();
    expect(() =>
      listener?.(Object.assign(new Error("broken pipe"), { code: "EPIPE" })),
    ).not.toThrow();
    expect(stream.errorListener).toBeUndefined();
  });
});

describe("handoffHookOutput", () => {
  it("acknowledges only after stdout succeeds", async () => {
    const stream = new FakeOutput();
    const order: string[] = [];
    const pending = handoffHookOutput(
      { systemMessage: "safe" },
      async () => {
        order.push("ack");
      },
      stream,
    );
    order.push("write-started");
    await Promise.resolve();
    expect(order).toEqual(["write-started"]);
    stream.callback?.();
    await expect(pending).resolves.toBe(true);
    expect(order).toEqual(["write-started", "ack"]);
  });

  it("does not acknowledge after a failed stdout handoff", async () => {
    const stream = new FakeOutput();
    let acknowledged = false;
    const pending = handoffHookOutput(
      {},
      async () => {
        acknowledged = true;
      },
      stream,
    );
    stream.callback?.(new Error("EPIPE"));
    await expect(pending).resolves.toBe(false);
    expect(acknowledged).toBe(false);
  });

  it("swallows acknowledgment failure so the hook output remains successful", async () => {
    const stream = new FakeOutput();
    const pending = handoffHookOutput(
      {},
      async () => {
        throw new Error("network down");
      },
      stream,
    );
    stream.callback?.();
    await expect(pending).resolves.toBe(true);
  });
});
