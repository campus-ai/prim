#!/usr/bin/env node
/**
 * prim — CLI for managing Primitive specs and contexts.
 *
 * Usage:
 *   prim auth login|set-token|clear
 *   prim context list|get|create|update|delete|link|unlink
 *   prim spec list|get|update|sync
 *   prim hooks install|uninstall
 *
 * Configuration:
 *   Connects to https://api.getprimitive.ai by default.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import updateNotifier from "update-notifier";
import { registerAuthCommands } from "./commands/auth.js";
import { registerClaudeInstallCommands } from "./commands/claude-install.js";
import { registerContextCommands } from "./commands/context.js";
import { registerHooksCommands } from "./commands/hooks.js";
import { registerMovesCommands } from "./commands/moves.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerSpecCommands } from "./commands/spec.js";
import { flushIfNeeded } from "./flusher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));

updateNotifier({ pkg }).notify();

const program = new Command();

program
  .name("prim")
  .description("CLI for managing Primitive specs and contexts")
  .version(pkg.version)
  .option("-y, --yes", "auto-confirm prompts")
  .option(
    "--non-interactive",
    "fail fast instead of prompting (also: CI=1, PRIM_NON_INTERACTIVE=1)",
  );

registerAuthCommands(program);
registerContextCommands(program);
registerSpecCommands(program);
registerProjectCommands(program);
registerHooksCommands(program);
registerSkillCommands(program);
registerMovesCommands(program);
registerClaudeInstallCommands(program);

// Surface API / network errors as clean one-liners
process.on("unhandledRejection", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});

// Opportunistic, non-blocking drain of the Decision Event journal. Never
// blocks the user's command behind the network drain, and is skipped for
// the explicit `prim moves flush`, which drains directly (a concurrent
// rotate-then-process drain would be harmless but redundant).
const argv = process.argv.slice(2);
const isExplicitFlush = argv[0] === "moves" && argv[1] === "flush";
if (!isExplicitFlush) {
  flushIfNeeded().catch(() => {
    // Best-effort; flushIfNeeded already swallows its own failures.
  });
}

program.parse();
