import { describe, expect, it, vi } from "vitest";
import { processIsAlive } from "./process-liveness.js";

describe("processIsAlive", () => {
  it("reports a process when the zero-signal probe succeeds", () => {
    const probe = vi.fn();

    expect(processIsAlive(42, probe)).toBe(true);
    expect(probe).toHaveBeenCalledWith(42, 0);
  });

  it("treats EPERM as proof that the process exists", () => {
    const probe = vi.fn(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });

    expect(processIsAlive(42, probe)).toBe(true);
  });

  it("treats ESRCH as a dead process", () => {
    const probe = vi.fn(() => {
      throw Object.assign(new Error("not found"), { code: "ESRCH" });
    });

    expect(processIsAlive(42, probe)).toBe(false);
  });

  it.each([0, -1, 1.5, Number.NaN])("rejects invalid PID %s without probing", (pid) => {
    const probe = vi.fn();

    expect(processIsAlive(pid, probe)).toBe(false);
    expect(probe).not.toHaveBeenCalled();
  });
});
