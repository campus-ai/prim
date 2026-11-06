#!/usr/bin/env node
/** Bounded supervisor; blocking local work runs in a disposable process. */
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseAgent } from "./agent.js";

const OUTPUT_RESERVE_MS = 150;
const MAX_OUTPUT_BYTES = 262_144;
const agent = parseAgent(process.argv);
const budgetMs = agent === "claude_code" ? 15_000 : 2_000;
const silent =
  agent === "cursor"
    ? { permission: "allow" }
    : agent === "claude_code"
      ? {
          hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "allow" },
        }
      : {};
const unverified = "[primitive] Decision check could not finish; change was not verified.";
const optedOut =
  process.env.PRIM_HOOK_MODE === "off" ||
  process.env.PRIM_BYPASS === "1" ||
  process.env.PRIM_BYPASS === "true";
const fallback =
  agent === "claude_code" && !optedOut
    ? {
        systemMessage: unverified,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "allow",
          additionalContext: unverified,
        },
      }
    : silent;
const remaining = Math.max(0, budgetMs - process.uptime() * 1_000 - OUTPUT_RESERVE_MS);
let child: ChildProcess | undefined;
let finished = false;
let stdout = "";
let stderr = "";

function stopWorker(): void {
  if (!child?.pid) return;
  try {
    // Also reap synchronous Git subprocesses; they must not outlive the hook.
    if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    /* The worker may already have exited. */
  }
}

function finish(output: unknown = fallback, diagnostics = ""): void {
  if (finished) return;
  finished = true;
  clearTimeout(timer);
  process.stdin.unpipe();
  process.stdin.pause();
  stopWorker();
  if (diagnostics) process.stderr.write(diagnostics);
  process.stdout.write(`${JSON.stringify(output)}\n`, () => process.exit(0));
}
const timer = setTimeout(() => finish(), remaining);
process.once("SIGTERM", () => finish());
process.once("SIGINT", () => finish());
process.once("exit", stopWorker);
if (remaining <= 0) finish();
else {
  try {
    child = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./pre-tool-use-worker.js", import.meta.url)),
        "--agent",
        agent,
        String(Date.now() + remaining - 50),
      ],
      {
        detached: process.platform !== "win32",
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    child.on("error", () => finish());
    child.stdin?.on("error", () => finish());
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(0, MAX_OUTPUT_BYTES);
    });
    child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT_BYTES) return finish();
      if (!stdout.includes("\n")) return;
      try {
        const message: unknown = JSON.parse(stdout);
        if (
          !message ||
          typeof message !== "object" ||
          !("output" in message) ||
          !("confirmed" in message)
        )
          return finish();
        if (!message.output || typeof message.output !== "object" || Array.isArray(message.output))
          return finish();
        if (message.confirmed === true) finish(message.output, stderr);
        else finish();
      } catch {
        finish();
      }
    });
    child.on("exit", () => finish());
    if (child.stdin) process.stdin.pipe(child.stdin);
  } catch {
    finish();
  }
}
