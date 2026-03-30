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
 *   Set VITE_CONVEX_URL in your environment or .env.local file.
 */
import { Command } from "commander";
import { registerAuthCommands } from "./commands/auth.js";
import { registerContextCommands } from "./commands/context.js";
import { registerHooksCommands } from "./commands/hooks.js";
import { registerSpecCommands } from "./commands/spec.js";
import { registerTaskCommands } from "./commands/task.js";

const program = new Command();

program
  .name("prim")
  .description("CLI for managing Primitive specs and contexts")
  .version("0.1.0-beta.1");

registerAuthCommands(program);
registerContextCommands(program);
registerSpecCommands(program);
registerTaskCommands(program);
registerHooksCommands(program);

// Surface API / network errors as clean one-liners
process.on("unhandledRejection", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});

program.parse();
