/**
 * Context CRUD commands for the prim CLI.
 *
 * prim context list [--scope task|global|external] [--task-id <id>]
 * prim context get <context-id>
 * prim context create --scope <scope> --name <name> [--text <text>] [--file <path>]
 * prim context update <context-id> [--name <name>] [--text <text>]
 * prim context delete <context-id>
 * prim context link <context-id> --task <task-id>
 * prim context unlink <context-id> --task <task-id>
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
    .option("-s, --scope <scope>", "Filter by scope: task, global, external")
    .option("-t, --task-id <taskId>", "List contexts linked to a specific task")
    .action(async (opts: { scope?: string; taskId?: string }) => {
      const client = getClient();

      const params = new URLSearchParams();
      if (opts.taskId) {
        params.set("taskId", opts.taskId);
      }
      if (opts.scope) {
        params.set("scope", opts.scope);
      }

      const contexts = (await client.get(
        `/api/cli/contexts?${params.toString()}`
      )) as Array<Record<string, unknown>>;
      printContextList(contexts);
    });

  // ── get ───────────────────────────────────────────────────────────────
  context
    .command("get <contextId>")
    .description("Get a context by ID")
    .action(async (contextId: string) => {
      const client = getClient();
      const ctx = (await client.get(
        `/api/cli/contexts/${contextId}`
      )) as Record<string, unknown>;

      console.log(JSON.stringify(ctx, null, 2));
    });

  // ── create ────────────────────────────────────────────────────────────
  context
    .command("create")
    .description("Create a new context")
    .requiredOption("-s, --scope <scope>", "Scope: task, global, external")
    .requiredOption("-n, --name <name>", "Context name")
    .option("-t, --text <text>", "Context text content")
    .option("-f, --file <path>", "Read text content from file")
    .option("--task-id <taskId>", "Link to task(s), comma-separated")
    .option("--spec", "Mark as a spec document")
    .action(
      async (opts: {
        scope: string;
        name: string;
        text?: string;
        file?: string;
        taskId?: string;
        spec?: boolean;
      }) => {
        const client = getClient();

        let text = opts.text;
        if (opts.file) {
          text = readFileSync(opts.file, "utf-8");
        }

        const taskIds = opts.taskId
          ? opts.taskId.split(",").map((id) => id.trim())
          : undefined;

        const result = (await client.post("/api/cli/contexts", {
          scope: opts.scope,
          name: opts.name,
          text,
          taskIds,
          isSpecDocument: opts.spec ?? false,
        })) as { _id: string };

        console.log(`Created context: ${result._id}`);
      }
    );

  // ── update ────────────────────────────────────────────────────────────
  context
    .command("update <contextId>")
    .description("Update a context")
    .option("-n, --name <name>", "New name")
    .option("-t, --text <text>", "New text content")
    .option("-f, --file <path>", "Read text content from file")
    .action(
      async (
        contextId: string,
        opts: { name?: string; text?: string; file?: string }
      ) => {
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
      }
    );

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
    .description("Link a context to a task")
    .requiredOption("--task <taskId>", "Task ID to link to")
    .action(async (contextId: string, opts: { task: string }) => {
      const client = getClient();
      await client.post(`/api/cli/contexts/${contextId}/link`, {
        taskId: opts.task,
      });
      console.log(`Linked context ${contextId} to task ${opts.task}`);
    });

  // ── unlink ────────────────────────────────────────────────────────────
  context
    .command("unlink <contextId>")
    .description("Unlink a context from a task")
    .requiredOption("--task <taskId>", "Task ID to unlink from")
    .action(async (contextId: string, opts: { task: string }) => {
      const client = getClient();
      await client.post(`/api/cli/contexts/${contextId}/unlink`, {
        taskId: opts.task,
      });
      console.log(`Unlinked context ${contextId} from task ${opts.task}`);
    });
}

function printContextList(contexts: Array<Record<string, unknown>>) {
  if (contexts.length === 0) {
    console.log("No contexts found.");
    return;
  }

  for (const ctx of contexts) {
    const scope = (ctx.scope as string) ?? "task";
    const spec = ctx.isSpecDocument ? " [SPEC]" : "";
    const name = ctx.name ?? ctx.title ?? "(unnamed)";
    console.log(`${ctx._id}  ${scope.padEnd(8)} ${name}${spec}`);
  }
  console.log(`\n${contexts.length} context(s)`);
}
