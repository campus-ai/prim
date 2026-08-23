#!/usr/bin/env node
/**
 * prim — CLI for Primitive's decision graph.
 *
 * Passively captures the decisions a team makes while coding, gates edits that
 * conflict with prior team decisions, and reports team presence.
 *
 * Usage:
 *   prim auth login|set-token|clear|status
 *   prim claude install|uninstall|status   (or: prim codex ...)
 *   prim hooks install|uninstall
 *   prim daemon start|stop|status
 *   prim doctor
 *   prim decisions recent|show|cascade|check|publish|restore|supersede|confirm|create
 *   prim reconcile <id>
 *   prim welcome
 *
 * Configuration:
 *   Connects to https://api.getprimitive.ai by default.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import updateNotifier from "update-notifier";
import { registerActivationCommands } from "./commands/activation.js";
import { registerAuthCommands } from "./commands/auth.js";
import { registerClaudeCommands } from "./commands/claude-install.js";
import { registerCodexCommands } from "./commands/codex-install.js";
import { registerDaemonCommands } from "./commands/daemon.js";
import { registerDecisionsCommands } from "./commands/decisions.js";
import { registerDoctorCommands } from "./commands/doctor.js";
import { registerHermesCommands } from "./commands/hermes-install.js";
import { registerHooksCommands } from "./commands/hooks.js";
import { registerMovesCommands } from "./commands/moves.js";
import { registerReconcileCommands } from "./commands/reconcile.js";
import { registerSessionCommands } from "./commands/session.js";
import { registerSetupCommand } from "./commands/setup.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerStatuslineCommands } from "./commands/statusline.js";
import { registerWelcomeCommand } from "./commands/welcome.js";
import { flushIfNeeded } from "./flusher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));

updateNotifier({ pkg }).notify();

const program = new Command();

program
  .name("prim")
  .description("CLI for Primitive's decision graph")
  .version(pkg.version)
  .option("-y, --yes", "auto-confirm prompts")
  .option(
    "--non-interactive",
    "fail fast instead of prompting (also: CI=1, PRIM_NON_INTERACTIVE=1)",
  );

registerAuthCommands(program);
registerHooksCommands(program);
registerActivationCommands(program);
registerSkillCommands(program);
registerMovesCommands(program);
registerSessionCommands(program);
registerDecisionsCommands(program);
registerClaudeCommands(program);
registerCodexCommands(program);
registerHermesCommands(program);
registerDaemonCommands(program);
registerDoctorCommands(program);
registerReconcileCommands(program);
registerStatuslineCommands(program);
registerWelcomeCommand(program);
registerSetupCommand(program);

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
