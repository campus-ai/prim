import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { boundedHealthError } from "../lib/ansi.js";
import { terminalSafeLine } from "../lib/terminal-safe.js";
import { scrub } from "./redact.js";

const mocks = vi.hoisted(() => ({
  buildHookOutput: vi.fn(() => ({})),
  handoffHookOutput: vi.fn(),
  readFileSync: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return { ...actual, readFileSync: mocks.readFileSync };
});
vi.mock("./decision-feedback-core.js", () => ({
  buildHookOutput: mocks.buildHookOutput,
  handoffHookOutput: mocks.handoffHookOutput,
}));

const DEBUG_PREFIX = "[prim-hook] capture failed: ";
const originalDebug = process.env.PRIM_HOOK_DEBUG;
let stderrWrites: string[] = [];

async function runWithReadFailure(detail: string, debug: boolean): Promise<void> {
  if (debug) process.env.PRIM_HOOK_DEBUG = "1";
  else Reflect.deleteProperty(process.env, "PRIM_HOOK_DEBUG");

  mocks.readFileSync.mockImplementation(() => {
    throw new Error(detail);
  });
  mocks.handoffHookOutput.mockResolvedValue(true);

  await import("./prim-hook.js");
  await vi.waitFor(() => expect(mocks.handoffHookOutput).toHaveBeenCalledTimes(1));
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  stderrWrites = [];
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown) => {
    stderrWrites.push(String(chunk));
    return true;
  }) as typeof process.stderr.write);
});

afterEach(() => {
  if (originalDebug === undefined) Reflect.deleteProperty(process.env, "PRIM_HOOK_DEBUG");
  else process.env.PRIM_HOOK_DEBUG = originalDebug;
  vi.restoreAllMocks();
});

describe("prim-hook debug output", () => {
  it("neutralizes and bounds hostile error text", async () => {
    const escapeCharacter = String.fromCharCode(0x1b);
    const bell = String.fromCharCode(0x07);
    const hostile =
      `before${escapeCharacter}]8;;https://example.invalid${bell}link${escapeCharacter}]8;;${bell}\r\n` +
      `${escapeCharacter}[2J\u202ereordered\u200bhidden\u2066${"x".repeat(300)}`;

    await runWithReadFailure(hostile, true);

    const output = stderrWrites.join("");
    expect(output.startsWith(DEBUG_PREFIX)).toBe(true);
    expect(output.endsWith("\n")).toBe(true);
    const line = output.slice(0, -1);
    expect(line).not.toContain(escapeCharacter);
    expect(line).not.toContain(bell);
    expect(line).not.toContain("\r");
    expect(line).not.toContain("\u202e");
    expect(line).not.toContain("\u200b");
    expect(line).not.toContain("\u2066");
    expect(line).toBe(
      `[prim-hook] ${boundedHealthError(scrub(terminalSafeLine(`capture failed: ${hostile}`)) as string)}`,
    );
  });

  it("keeps debug output disabled unless explicitly requested", async () => {
    await runWithReadFailure("hostile\u001b[2J detail", false);

    expect(stderrWrites).toEqual([]);
  });

  it("omits a detail that normalizes to empty", async () => {
    await runWithReadFailure("\u001b\u0007\u202e\u200b\u2066", true);

    expect(stderrWrites).toEqual(["[prim-hook] capture failed\n"]);
  });
});
