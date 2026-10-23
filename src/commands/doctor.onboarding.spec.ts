import { Command } from "commander";
import { afterEach, describe, expect, it, vi } from "vitest";
import { registerDoctorCommands } from "./doctor.js";

const originalExit = process.exitCode;
afterEach(() => {
  vi.restoreAllMocks();
  process.exitCode = originalExit;
});

describe("onboarding health diagnostics", () => {
  it.each([undefined, "codex"])(
    "scopes absent integration advice for %s without hiding failures",
    async (agent) => {
      const stdout = vi.spyOn(console, "log").mockImplementation(() => {});
      const stderr = vi.spyOn(process.stderr, "write").mockReturnValue(true);
      const program = new Command();
      registerDoctorCommands(program, {
        probes: {
          delivery: async () => ({
            snapshot: null,
            disabled: true,
            expectedVersion: null,
            stats: {
              pendingCount: 0,
              strandedCount: 0,
              strandedFileCount: 0,
              sampled: false,
              strandedSampled: false,
            },
            now: Date.now(),
          }),
          independent: async () => ({
            before: [{ name: "auth", status: "ok", detail: "valid" }],
            after: [
              {
                name: "feedback-hooks",
                status: "warn",
                detail: "Claude lifecycle hooks missing — run `prim claude install`",
              },
              { name: "pre-commit", status: "warn", detail: "unsupported_interpreter" },
              { name: "cursor-hooks", status: "fail", detail: "installed but broken" },
            ],
          }),
        },
      });
      await program.parseAsync(["doctor", "--compact", ...(agent ? ["--agent", agent] : [])], {
        from: "user",
      });
      const result = JSON.parse(stdout.mock.calls[0][0]);
      const narration = stderr.mock.calls.map(([text]) => text).join("");
      expect(result.checks.some((check: { name: string }) => check.name === "feedback-hooks")).toBe(
        !agent,
      );
      expect(result.checks).toContainEqual({ name: "auth", status: "ok", detail: "valid" });
      expect(narration).not.toContain("valid");
      expect(narration).toContain("unsupported_interpreter");
      expect(narration).toContain("installed but broken");
      expect(result.ok).toBe(false);
      expect(process.exitCode).not.toBe(0);
    },
  );
});
