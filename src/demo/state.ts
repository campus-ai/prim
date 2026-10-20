import { createHash, randomUUID } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Agent } from "../hooks/agent.js";
import { atomicWriteFile } from "../lib/atomic-file.js";
import { withFileLockSync } from "../lib/file-lock.js";
import { primConfigDirectory } from "../lib/paths.js";

export const RUN_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export type DemoStage = "prepared" | "proposal" | "conflict" | "completed" | "skipped";
export type DemoAction = "start" | "confirm" | "resolve" | "skip";
export type DemoChoice = "repository" | "local-storage";
export type DemoRun = {
  version: 1;
  id: string;
  stage: DemoStage;
  agent?: Agent;
  terminal: boolean;
  launcher: [string, string];
  binding?: string;
  acknowledgment?: { command: string; at: number };
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
    run.version !== 1 ||
    run.id !== id ||
    !["prepared", "proposal", "conflict", "completed", "skipped"].includes(run.stage) ||
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
    version: 1,
    id: randomUUID(),
    stage: "prepared",
    terminal,
    agent,
    launcher: [process.execPath, resolve(process.argv[1])],
  };
  saveRun(run);
  return run;
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function demoCommand(run: DemoRun, action: DemoAction, choice?: DemoChoice): string {
  return [
    ...run.launcher,
    "demo",
    action,
    run.id,
    ...(choice === undefined ? [] : ["--choice", choice]),
  ]
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
