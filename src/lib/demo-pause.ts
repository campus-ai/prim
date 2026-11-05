/**
 * Pausing capture for the onboarding demo.
 *
 * Setup activates the repository, so the welcome demo pauses capture rather
 * than requiring an inactive repo: it records the pause in the repo-local git
 * config (`prim.demoPause`), next to the `prim.active` value it saves, and sets
 * `prim.active=false`, which every capture path already skips. Living in the
 * repo's own config, the pause is shared by every worktree and dropped by
 * `prim enable` / `prim disable`.
 *
 * When the demo ends, the pause is marked ending rather than lifted, so the
 * demo's last tool call and the reply that reports it stay uncaptured; the
 * user's next prompt lifts it. Any pause also expires, so an abandoned demo
 * cannot leave a repository off: the capture gate heals an expired pause the
 * next time it reads the config.
 *
 * Imports nothing from activation.ts, which calls it.
 */
import { execFileSync } from "node:child_process";

export const DEMO_PAUSE_MS = 30 * 60_000;
const PAUSE_KEY = "prim.demoPause";
const GIT_TIMEOUT_MS = 1_000;

type Flag = "true" | "false" | "unset";

export type DemoPause = {
  runId: string;
  until: number;
  /** The repo-local `prim.active` value to restore. */
  previous: Flag;
  /** The demo is over; the next user prompt lifts the pause. */
  ending: boolean;
};

function git(cwd: string, args: string[]): string | undefined {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    });
  } catch {
    return undefined;
  }
}

function setLocal(cwd: string, key: string, value: string | null): void {
  try {
    execFileSync(
      "git",
      value === null ? ["config", "--local", "--unset", key] : ["config", "--local", key, value],
      { cwd, stdio: ["ignore", "ignore", "pipe"], timeout: GIT_TIMEOUT_MS },
    );
  } catch (error) {
    // Unsetting an already unset key exits 5; anything else is a real failure.
    if (value !== null || (error as { status?: number }).status !== 5) throw error;
  }
}

function parsePause(value: string): DemoPause {
  const [runId = "", until, previous, state] = value.trim().split(" ");
  const flag: Flag = previous === "true" || previous === "false" ? previous : "unset";
  // An unreadable record restores "unset" and is treated as expired.
  return { runId, until: Number(until) || 0, previous: flag, ending: state !== "active" };
}

function writePause(cwd: string, pause: DemoPause): void {
  setLocal(
    cwd,
    PAUSE_KEY,
    `${pause.runId} ${pause.until} ${pause.previous} ${pause.ending ? "ending" : "active"}`,
  );
}

/**
 * The effective `prim.active` (local over global) and any demo pause, in one
 * git call: the capture gate runs on every hook event.
 */
export function readCaptureConfig(cwd: string): {
  active: "true" | "false" | undefined;
  pause?: DemoPause;
} {
  let active: "true" | "false" | undefined;
  let pause: DemoPause | undefined;
  const out = git(cwd, ["config", "--get-regexp", "^prim\\.(active|demopause)$"]) ?? "";
  for (const line of out.split("\n")) {
    const space = line.indexOf(" ");
    const key = line.slice(0, space).toLowerCase();
    const value = line.slice(space + 1);
    if (key === "prim.active") active = value === "true" || value === "false" ? value : undefined;
    if (key === "prim.demopause") pause = parsePause(value);
  }
  return { active, pause };
}

export function readDemoPause(cwd: string): DemoPause | undefined {
  const value = git(cwd, ["config", "--local", "--get", PAUSE_KEY]);
  return value === undefined ? undefined : parsePause(value);
}

/** Pause capture on behalf of a demo run. A newer run keeps the original saved value. */
export function pauseCaptureForDemo(cwd: string, runId: string, now = Date.now()): void {
  const local = git(cwd, ["config", "--local", "--get", "prim.active"])?.trim();
  const previous: Flag =
    readDemoPause(cwd)?.previous ?? (local === "true" || local === "false" ? local : "unset");
  // The record lands first, so an interrupted pause still restores.
  writePause(cwd, { runId, until: now + DEMO_PAUSE_MS, previous, ending: false });
  setLocal(cwd, "prim.active", "false");
}

/** Keep a run's pause alive while the user works through the demo. */
export function extendDemoPause(cwd: string, runId: string, now = Date.now()): void {
  const pause = readDemoPause(cwd);
  if (pause?.runId === runId) writePause(cwd, { ...pause, until: now + DEMO_PAUSE_MS });
}

/** The demo is over: lift the pause at the user's next prompt, or at expiry. */
export function endDemoPause(cwd: string, runId: string, now = Date.now()): void {
  const pause = readDemoPause(cwd);
  if (pause?.runId === runId)
    writePause(cwd, { ...pause, until: now + DEMO_PAUSE_MS, ending: true });
}

/** Restore the saved value and drop the pause. */
export function resumeCapture(cwd: string, pause: DemoPause): void {
  setLocal(cwd, "prim.active", pause.previous === "unset" ? null : pause.previous);
  setLocal(cwd, PAUSE_KEY, null);
}

/** Drop a pause without restoring: `prim enable` / `disable` set the flag themselves. */
export function clearDemoPause(cwd: string): void {
  setLocal(cwd, PAUSE_KEY, null);
}

/** Lift a pause that expired, or one that is ending when the user prompts. */
export function healDemoPause(
  cwd: string,
  pause: DemoPause,
  options: { userPrompt?: boolean; now?: number } = {},
): boolean {
  if (pause.until > (options.now ?? Date.now()) && !(pause.ending && options.userPrompt))
    return false;
  try {
    resumeCapture(cwd, pause);
    return true;
  } catch {
    return false;
  }
}
