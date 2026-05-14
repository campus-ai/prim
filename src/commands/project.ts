/**
 * Project commands for the prim CLI.
 *
 * prim project create --name <name> [--description <text>] [--spec <contextId>]
 */

import type { Command } from "commander";
import { getClient } from "../client.js";
import { printJson } from "../output.js";

export function registerProjectCommands(program: Command) {
  const project = program.command("project").description("Manage projects");

  project
    .command("create")
    .description("Create a new project")
    .requiredOption("-n, --name <name>", "Project name")
    .option("-d, --description <description>", "Project description")
    .option("--spec <contextId>", "Link an existing spec as this project's spec")
    .option("--json", "Output as JSON")
    .action(async (opts: { name: string; description?: string; spec?: string; json?: boolean }) => {
      const client = getClient();

      const result = (await client.post("/api/cli/tasks", {
        name: opts.name,
        description: opts.description,
        specContextId: opts.spec,
      })) as { _id: string };

      if (opts.json) {
        printJson(opts.spec ? { _id: result._id, spec: opts.spec } : { _id: result._id });
        return;
      }

      console.error(`Created project: ${result._id}`);
      if (opts.spec) {
        console.error(`Linked spec: ${opts.spec}`);
      }
      console.log(result._id);
    });
}
