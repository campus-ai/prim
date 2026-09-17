#!/usr/bin/env node
/**
 * Lightweight Claude Code status-line entrypoint.
 *
 * This deliberately bypasses the Commander/update-notifier/journal-flush graph
 * in index.ts. Claude refreshes the status line frequently and cancels slow
 * invocations; this process performs one bounded local socket read and always
 * emits a deterministic line.
 */
import { readPackageVersion, renderStatusline } from "./commands/statusline.js";
import { readHookStdin } from "./hooks/hook-stdin.js";

async function inputCwd(): Promise<string | undefined> {
  try {
    const raw = await readHookStdin(200, 64 * 1024);
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    const input = parsed as Record<string, unknown>;
    if (typeof input.cwd === "string" && input.cwd.length > 0) return input.cwd;
    if (input.workspace && typeof input.workspace === "object" && !Array.isArray(input.workspace)) {
      const current = (input.workspace as Record<string, unknown>).current_dir;
      if (typeof current === "string" && current.length > 0) return current;
    }
  } catch {
    // Claude may invoke the statusline without stdin; the process cwd remains valid there.
  }
}

async function main(): Promise<void> {
  try {
    process.stdout.write(await renderStatusline((await inputCwd()) ?? process.cwd()));
  } catch {
    process.stdout.write(`primitive ${readPackageVersion()} (daemon: unavailable)`);
  }
}

void main();
