import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { isDemoStatusResponse } from "../contract/cli-http-v1.js";
import type { Agent } from "../hooks/agent.js";
import { atomicWriteFile } from "../lib/atomic-file.js";
import { withFileLock, withFileLockSync } from "../lib/file-lock.js";
import { primConfigDirectory } from "../lib/paths.js";

export const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export type DemoStage =
  | "prepared"
  | "proposal"
  | "conflict"
  | "prompt"
  | "approved"
  | "applied"
  | "cleanup"
  | "completed"
  | "skipped";
export type DemoAction = "start" | "attempt" | "resolve" | "status" | "skip";
export type DemoChoice = "adhere" | "supersede";
export type DemoRun = {
  version: 1 | 2;
  id: string;
  stage: DemoStage;
  agent?: Agent;
  terminal: boolean;
  launcher: [string, string];
  binding?: string;
  preparationKey?: string;
  acknowledgment?: { command: string; at: number };
  server?: import("../contract/cli-http-v1.js").DemoStatusResponse;
  needsStatus?: boolean;
  receipt?: { revision: number; appliedDigest: string };
  sandbox?: { path: string; device: number; inode: number };
};

export const demoDirectory = () => join(primConfigDirectory(), "demo");
export const runPath = (id: string) => {
  if (!RUN_ID.test(id)) throw new Error("invalid demo run ID");
  return join(demoDirectory(), "runs", `${id}.json`);
};

export function readDemoJson(path: string): unknown {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.size > 16_384) throw new Error(`invalid demo state: ${path}`);
  return JSON.parse(readFileSync(path, "utf8"));
}

export function saveDemoJson(path: string, value: unknown): void {
  atomicWriteFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600, ensureParent: true });
}

export function readRun(id: string): DemoRun {
  const run = readDemoJson(runPath(id)) as DemoRun;
  if (
    ![1, 2].includes(run.version) ||
    run.id !== id ||
    ![
      "prepared",
      "proposal",
      "conflict",
      "prompt",
      "approved",
      "applied",
      "cleanup",
      "completed",
      "skipped",
    ].includes(run.stage) ||
    (run.needsStatus !== undefined && typeof run.needsStatus !== "boolean") ||
    (run.server !== undefined && !isDemoStatusResponse(run.server)) ||
    (run.receipt !== undefined &&
      (!Number.isSafeInteger(run.receipt.revision) ||
        run.receipt.revision < 0 ||
        !/^[a-f0-9]{64}$/u.test(run.receipt.appliedDigest))) ||
    typeof run.terminal !== "boolean" ||
    !Array.isArray(run.launcher) ||
    run.launcher.length !== 2 ||
    run.launcher.some((value) => typeof value !== "string" || !value.startsWith("/")) ||
    (run.agent !== undefined && !["claude_code", "codex", "cursor", "hermes"].includes(run.agent))
  ) {
    throw new Error("invalid demo run state");
  }
  return run;
}

export const saveRun = (run: DemoRun) => saveDemoJson(runPath(run.id), run);
export const lockRun = <T>(id: string, action: (run: DemoRun) => T): T =>
  withFileLockSync(`${runPath(id)}.lock`, () => action(readRun(id)), { timeoutMs: 500 });

export function prepareRun(agent?: Agent, terminal = false): DemoRun {
  const run: DemoRun = {
    version: 2,
    id: randomUUID(),
    stage: "prepared",
    terminal,
    agent,
    preparationKey: preparationKey(agent),
    launcher: [process.execPath, resolve(process.argv[1])],
  };
  saveRun(run);
  return run;
}

/** A hint for setup recovery, never an isolation acknowledgment. */
export function preparationKey(agent?: Agent): string | undefined {
  return agent === "codex" && process.env.CODEX_THREAD_ID
    ? sessionKey(agent, `${process.env.CODEX_THREAD_ID}\0${process.cwd()}`)
    : undefined;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function demoCommand(
  run: DemoRun,
  action: DemoAction,
  choice?: DemoChoice,
  reason?: string,
): string {
  return [
    ...run.launcher,
    "demo",
    action,
    run.id,
    ...(choice === undefined ? [] : ["--choice", choice]),
    ...(reason === undefined ? [] : ["--reason", reason]),
  ]
    .map(quote)
    .join(" ");
}

/** Use the executable running this stage, including recovery from an expired npx cache. */
export function demoWelcomeCommand(run: DemoRun): string {
  return [
    process.execPath,
    resolve(process.argv[1]),
    "welcome",
    "--after-demo",
    ...(run.agent ? ["--agent", run.agent === "claude_code" ? "claude" : run.agent] : []),
    ...(run.binding ? ["--capture-excluded"] : []),
  ]
    .map(quote)
    .join(" ");
}

/** Diagnostics must also work when prim is available only through npx. */
export function demoDiagnosticCommand(run: DemoRun): string {
  return [process.execPath, resolve(process.argv[1]), "demo", "status", run.id]
    .map(quote)
    .join(" ");
}

export function demoResumeCommand(run: DemoRun): string {
  return [process.execPath, resolve(process.argv[1]), "demo", "resume", run.id]
    .map(quote)
    .join(" ");
}

export function onboardingFinished(): boolean {
  const path = join(demoDirectory(), "onboarding.json");
  if (!existsSync(path)) return false;
  const value = readDemoJson(path) as { outcome?: string };
  if (value.outcome !== "completed" && value.outcome !== "skipped") {
    throw new Error("invalid local onboarding outcome");
  }
  return true;
}

export function finishOnboarding(outcome: "completed" | "skipped"): void {
  saveDemoJson(join(demoDirectory(), "onboarding.json"), { outcome });
}

export function pendingRuns(): string[] {
  const path = join(demoDirectory(), "runs");
  if (!existsSync(path)) return [];
  return readdirSync(path)
    .filter((name) => name.endsWith(".json") && RUN_ID.test(name.slice(0, -5)))
    .map((name) => name.slice(0, -5))
    .filter((id) => !["completed", "skipped"].includes(readRun(id).stage));
}

export function sessionKey(agent: Agent, session: string): string {
  return createHash("sha256").update(`${agent}\0${session}`).digest("hex");
}

export function exclusionPath(key: string): string {
  if (!/^[0-9a-f]{64}$/u.test(key)) throw new Error("invalid demo session identity");
  return join(demoDirectory(), "excluded-sessions", `${key}.json`);
}

export function sessionExcluded(agent: Agent, session: unknown): boolean {
  if (typeof session !== "string" || !session) return false;
  const path = exclusionPath(sessionKey(agent, session));
  if (!existsSync(path)) return false;
  const record = readDemoJson(path) as { runId?: string };
  if (typeof record.runId !== "string" || !RUN_ID.test(record.runId)) {
    // An unreadable exclusion is not permission to capture.
    throw new Error("invalid demo capture exclusion");
  }
  return true;
}

export const lockRunAsync = <T>(id: string, action: (run: DemoRun) => Promise<T>): Promise<T> =>
  withFileLock(`${runPath(id)}.lock`, () => action(readRun(id)), { timeoutMs: 500 });

/** Parse only our single-quoted argv serialization; never interpret shell syntax. */
export function demoArgv(command: string): string[] | undefined {
  const result: string[] = [];
  let i = 0;
  while (i < command.length) {
    if (command[i++] !== "'") return;
    let value = "";
    let closed = false;
    while (i < command.length) {
      if (command.slice(i, i + 4) === "'\\''") {
        value += "'";
        i += 4;
      } else if (command[i] === "'") {
        i++;
        closed = true;
        break;
      } else {
        value += command[i++];
      }
    }
    if (!closed) return;
    result.push(value);
    if (i === command.length) return result;
    if (command[i++] !== " " || i === command.length) return;
  }
}
