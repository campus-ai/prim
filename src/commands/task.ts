/**
 * Task commands for the prim CLI.
 *
 * prim task create --name <name> [--description <text>] [--spec <contextId>]
 */

import type { Command } from "commander";
import { getClient } from "../client.js";

export function registerTaskCommands(program: Command) {
  const task = program.command("task").description("Manage tasks");

  task
    .command("create")
    .description("Create a new task")
    .requiredOption("-n, --name <name>", "Task name")
    .option("-d, --description <description>", "Task description")
    .option("--spec <contextId>", "Link an existing spec as this task's spec")
    .action(async (opts: { name: string; description?: string; spec?: string }) => {
      const client = getClient();

      const result = (await client.post("/api/cli/tasks", {
        name: opts.name,
        description: opts.description,
        specContextId: opts.spec,
      })) as { _id: string };

      console.log(`Created task: ${result._id}`);
      if (opts.spec) {
        console.log(`Linked spec: ${opts.spec}`);
      }
    });
}
