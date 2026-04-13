/**
 * Context CRUD commands for the prim CLI.
 *
 * prim context list [--scope project|global|external] [--project-id <id>]
 * prim context get <context-id>
 * prim context create --scope <scope> --name <name> [--text <text>] [--file <path>]
 * prim context update <context-id> [--name <name>] [--text <text>]
 * prim context delete <context-id>
 * prim context link <context-id> --project <project-id>
 * prim context unlink <context-id> --project <project-id>
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { getClient } from "../client.js";

export function registerContextCommands(program: Command) {
  const context = program.command("context").description("Manage contexts");

  // ── list ──────────────────────────────────────────────────────────────
  context
    .command("list")
    .description("List contexts")
    .option("-s, --scope <scope>", "Filter by scope: project, global, external")
    .option("-t, --project-id <projectId>", "List contexts linked to a specific project")
    .action(async (opts: { scope?: string; projectId?: string }) => {
      const client = getClient();

      const params = new URLSearchParams();
      if (opts.projectId) {
        params.set("taskId", opts.projectId);
      }
      if (opts.scope) {
        params.set("scope", opts.scope === "project" ? "task" : opts.scope);
      }

      const contexts = (await client.get(`/api/cli/contexts?${params.toString()}`)) as Array<
        Record<string, unknown>
      >;
      printContextList(contexts);
    });

  // ── get ───────────────────────────────────────────────────────────────
  context
    .command("get <contextId>")
    .description("Get a context by ID")
    .action(async (contextId: string) => {
      const client = getClient();
      const ctx = (await client.get(`/api/cli/contexts/${contextId}`)) as Record<string, unknown>;

      console.log(JSON.stringify(ctx, null, 2));
    });

  // ── create ────────────────────────────────────────────────────────────
  context
    .command("create")
    .description("Create a new context")
    .requiredOption("-s, --scope <scope>", "Scope: project, global, external")
    .requiredOption("-n, --name <name>", "Context name")
    .option("-t, --text <text>", "Context text content")
    .option("-f, --file <path>", "Read text content from file")
    .option("--project-id <projectId>", "Link to project(s), comma-separated")
    .option("--spec", "Mark as a spec document")
    .action(
      async (opts: {
        scope: string;
        name: string;
        text?: string;
        file?: string;
        projectId?: string;
        spec?: boolean;
      }) => {
        const client = getClient();

        let text = opts.text;
        if (opts.file) {
          text = readFileSync(opts.file, "utf-8");
        }

        const taskIds = opts.projectId
          ? opts.projectId.split(",").map((id) => id.trim())
          : undefined;

        const result = (await client.post("/api/cli/contexts", {
          scope: opts.scope === "project" ? "task" : opts.scope,
          name: opts.name,
          text,
          taskIds,
          isSpecDocument: opts.spec ?? false,
        })) as { _id: string };

        console.log(`Created context: ${result._id}`);
      },
    );

  // ── update ────────────────────────────────────────────────────────────
  context
    .command("update <contextId>")
    .description("Update a context")
    .option("-n, --name <name>", "New name")
    .option("-t, --text <text>", "New text content")
    .option("-f, --file <path>", "Read text content from file")
    .action(async (contextId: string, opts: { name?: string; text?: string; file?: string }) => {
      const client = getClient();

      let text = opts.text;
      if (opts.file) {
        text = readFileSync(opts.file, "utf-8");
      }

      await client.patch(`/api/cli/contexts/${contextId}`, {
        name: opts.name,
        text,
      });

      console.log(`Updated context: ${contextId}`);
    });

  // ── delete ────────────────────────────────────────────────────────────
  context
    .command("delete <contextId>")
    .description("Delete a context")
    .action(async (contextId: string) => {
      const client = getClient();
      await client.delete(`/api/cli/contexts/${contextId}`);
      console.log(`Deleted context: ${contextId}`);
    });

  // ── link ──────────────────────────────────────────────────────────────
  context
    .command("link <contextId>")
    .description("Link a context to a project")
    .requiredOption("--project <projectId>", "Project ID to link to")
    .action(async (contextId: string, opts: { project: string }) => {
      const client = getClient();
      await client.post(`/api/cli/contexts/${contextId}/link`, {
        taskId: opts.project,
      });
      console.log(`Linked context ${contextId} to project ${opts.project}`);
    });

  // ── unlink ────────────────────────────────────────────────────────────
  context
    .command("unlink <contextId>")
    .description("Unlink a context from a project")
    .requiredOption("--project <projectId>", "Project ID to unlink from")
    .action(async (contextId: string, opts: { project: string }) => {
      const client = getClient();
      await client.post(`/api/cli/contexts/${contextId}/unlink`, {
        taskId: opts.project,
      });
      console.log(`Unlinked context ${contextId} from project ${opts.project}`);
    });
}

function printContextList(contexts: Array<Record<string, unknown>>) {
  if (contexts.length === 0) {
    console.log("No contexts found.");
    return;
  }

  for (const ctx of contexts) {
    const scope =
      (ctx.scope as string) === "task" ? "project" : ((ctx.scope as string) ?? "project");
    const spec = ctx.isSpecDocument ? " [SPEC]" : "";
    const name = ctx.name ?? ctx.title ?? "(unnamed)";
    console.log(`${ctx._id}  ${scope.padEnd(8)} ${name}${spec}`);
  }
  console.log(`\n${contexts.length} context(s)`);
}
