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
import { registerAuthCommands } from "./commands/auth.js";
import { registerContextCommands } from "./commands/context.js";
import { registerHooksCommands } from "./commands/hooks.js";
import { registerProjectCommands } from "./commands/project.js";
import { registerSkillCommands } from "./commands/skill.js";
import { registerSpecCommands } from "./commands/spec.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(resolve(__dirname, "../package.json"), "utf-8"));

const program = new Command();

program
  .name("prim")
  .description("CLI for managing Primitive specs and contexts")
  .version(pkg.version);

registerAuthCommands(program);
registerContextCommands(program);
registerSpecCommands(program);
registerProjectCommands(program);
registerHooksCommands(program);
registerSkillCommands(program);

// Surface API / network errors as clean one-liners
process.on("unhandledRejection", (err) => {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(msg);
  process.exit(1);
});

program.parse();
