import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent } from "../hooks/agent.js";
import { inspectHookRuntime } from "../lib/hook-runtime.js";
import { type DemoRun, demoDirectory, readDemoJson, saveDemoJson, sessionKey } from "./state.js";

// One bounded, content-free observation per run. Never store tool input, sample
// content, a raw session ID, or an error message that might contain those values.
export type DemoObservation = {
  at: number;
  agent: Agent;
  runtimeVersion?: string;
  session?: string;
  result:
    | "acknowledged"
    | "tool-mismatch"
    | "command-mismatch"
    | "session-mismatch"
    | "session-missing"
    | "write-failed";
  errorCode?: string;
};
const observationPath = (id: string) => join(demoDirectory(), "observations", `${id}.json`);
export function observeRun(id: string, observation: DemoObservation): void {
  try {
    saveDemoJson(observationPath(id), observation);
  } catch {
    // The same permission boundary may prevent both acknowledgment and logging.
    process.stderr.write(
      "[prim] demo isolation diagnostic could not be saved; check access to Primitive's configuration directory.\n",
    );
  }
}
export function isolationDiagnostics(run: DemoRun) {
  let observation: DemoObservation | undefined;
  let observationError: string | undefined;
  try {
    if (existsSync(observationPath(run.id))) {
      const value = readDemoJson(observationPath(run.id)) as Partial<DemoObservation> | null;
      if (
        !value ||
        !Number.isFinite(value.at) ||
        !["claude_code", "codex", "cursor", "hermes"].includes(value.agent ?? "") ||
        ![
          "acknowledged",
          "tool-mismatch",
          "command-mismatch",
          "session-mismatch",
          "session-missing",
          "write-failed",
        ].includes(value.result ?? "") ||
        (value.runtimeVersion !== undefined &&
          !/^[a-zA-Z0-9.+-]{1,80}$/u.test(value.runtimeVersion)) ||
        (value.session !== undefined && !/^[a-f0-9]{64}$/u.test(value.session)) ||
        (value.errorCode !== undefined && !/^[A-Z0-9_]{1,32}$/u.test(value.errorCode))
      )
        throw new Error("invalid demo observation");
      observation = value as DemoObservation;
    }
  } catch {
    observationError = "unreadable";
  }
  const expected =
    run.agent === "codex" && process.env.CODEX_THREAD_ID
      ? sessionKey(run.agent, process.env.CODEX_THREAD_ID)
      : undefined;
  return {
    runtime: inspectHookRuntime(),
    expectedEvent: "PreToolUse",
    expectedTool: run.agent === "cursor" ? "Shell" : run.agent === "hermes" ? "terminal" : "Bash",
    hookObservation: observation
      ? {
          at: observation.at,
          agent: observation.agent,
          runtimeVersion: observation.runtimeVersion ?? "unknown",
          result: observation.result,
          ageMs: Math.max(0, Date.now() - observation.at),
          sessionMatches: expected ? observation.session === expected : "unknown",
          ...(observation.errorCode ? { errorCode: observation.errorCode } : {}),
        }
      : null,
    ...(observationError ? { observationError } : {}),
    trust: "unknown",
    capture: run.binding ? "excluded-for-bound-session" : "not-verified",
  };
}
