/**
 * Project commands for the prim CLI.
 *
 * prim project create --name <name> [--description <text>] [--spec <contextId>]
 */

import type { Command } from "commander";
import { getClient } from "../client.js";

export function registerProjectCommands(program: Command) {
  const project = program.command("project").description("Manage projects");

  project
    .command("create")
    .description("Create a new project")
    .requiredOption("-n, --name <name>", "Project name")
    .option("-d, --description <description>", "Project description")
    .option("--spec <contextId>", "Link an existing spec as this project's spec")
    .action(async (opts: { name: string; description?: string; spec?: string }) => {
      const client = getClient();

      const result = (await client.post("/api/cli/tasks", {
        name: opts.name,
        description: opts.description,
        specContextId: opts.spec,
      })) as { _id: string };

      console.log(`Created project: ${result._id}`);
      if (opts.spec) {
        console.log(`Linked spec: ${opts.spec}`);
      }
    });
}
