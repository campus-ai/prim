/**
 * `prim doctor` verdict contract — the pure classifier.
 *
 * The auth/daemon/journal/server checks have side effects exercised by the
 * release smoke; here we pin the fold that matters: any failed check makes the
 * whole run unhealthy with exit 1, a warning alone is degraded-but-exit-0
 * (actionable, not broken), and the checks pass through verbatim for machine
 * consumers.
 */
import { describe, expect, it } from "vitest";
import { type Check, classifyDoctor } from "./doctor.js";

const ok = (name: string): Check => ({ name, status: "ok", detail: "" });
const warn = (name: string): Check => ({ name, status: "warn", detail: "" });
const fail = (name: string): Check => ({ name, status: "fail", detail: "" });

describe("classifyDoctor", () => {
  it("is healthy with exit 0 when every check is ok", () => {
    const { json, exitCode } = classifyDoctor([ok("auth"), ok("daemon")]);
    expect(json.status).toBe("ok");
    expect(json.ok).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("is degraded with exit 0 when a check warns but none fail", () => {
    const { json, exitCode } = classifyDoctor([ok("auth"), warn("daemon"), warn("stranded")]);
    expect(json.status).toBe("warn");
    expect(json.ok).toBe(true);
    expect(exitCode).toBe(0);
  });

  it("is unhealthy with exit 1 when any check fails (fail dominates warn)", () => {
    const { json, exitCode } = classifyDoctor([warn("daemon"), fail("auth"), ok("journal")]);
    expect(json.status).toBe("fail");
    expect(json.ok).toBe(false);
    expect(exitCode).toBe(1);
  });

  it("carries the checks through verbatim for machine consumers", () => {
    const checks = [ok("auth"), warn("stranded")];
    expect(classifyDoctor(checks).json.checks).toEqual(checks);
  });
});
