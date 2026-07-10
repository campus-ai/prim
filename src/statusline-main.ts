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

async function main(): Promise<void> {
  try {
    process.stdout.write(await renderStatusline());
  } catch {
    process.stdout.write(`primitive ${readPackageVersion()} (daemon: unavailable)`);
  }
}

void main();
