/**
 * Spec commands for the prim CLI.
 *
 * Specs are contexts with isSpecDocument=true. These commands provide
 * spec-specific views and operations on top of the unified context API.
 *
 * prim spec list [--task-id <id>]
 * prim spec get <context-id>
 * prim spec update <context-id> --text <text> | --file <path>
 * prim spec sync <context-id>
 */

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Command } from "commander";
import { getClient } from "../client.js";

export function registerSpecCommands(program: Command) {
  const spec = program.command("spec").description("Manage spec documents");

  // ── list ──────────────────────────────────────────────────────────────
  spec
    .command("list")
    .description("List spec documents")
    .option("-t, --task-id <taskId>", "List spec for a specific root task")
    .action(async (opts: { taskId?: string }) => {
      const client = getClient();

      if (opts.taskId) {
        const specs = (await client.get(`/api/cli/specs?rootTaskId=${opts.taskId}`)) as Array<
          Record<string, unknown>
        >;

        if (specs.length === 0) {
          console.log("No spec document found for this task.");
          return;
        }

        printSpec(specs[0]);
        return;
      }

      // List all spec documents
      const contexts = (await client.get("/api/cli/specs")) as Array<Record<string, unknown>>;

      if (contexts.length === 0) {
        console.log("No spec documents found.");
        return;
      }

      for (const ctx of contexts) {
        const scope = (ctx.scope as string) ?? "task";
        const review = ctx.specReviewStatus ?? "—";
        const name = ctx.name ?? "(unnamed)";
        console.log(`${ctx._id}  ${scope.padEnd(8)} ${String(review).padEnd(10)} ${name}`);
      }
      console.log(`\n${contexts.length} spec(s)`);
    });

  // ── get ───────────────────────────────────────────────────────────────
  spec
    .command("get <contextId>")
    .description("Get a spec document by ID")
    .option("--text-only", "Print only the text content (no metadata)")
    .action(async (contextId: string, opts: { textOnly?: boolean }) => {
      const client = getClient();
      const ctx = (await client.get(`/api/cli/contexts/${contextId}`)) as Record<string, unknown>;

      if (opts.textOnly) {
        console.log((ctx.text as string) ?? "");
        return;
      }

      printSpec(ctx);
    });

  // ── update ────────────────────────────────────────────────────────────
  spec
    .command("update <contextId>")
    .description("Update a spec document's text content")
    .option("-t, --text <text>", "New text content")
    .option("-f, --file <path>", "Read text content from file")
    .option("-n, --name <name>", "New name")
    .action(async (contextId: string, opts: { text?: string; file?: string; name?: string }) => {
      const client = getClient();

      let text = opts.text;
      if (opts.file) {
        text = readFileSync(opts.file, "utf-8");
      }

      if (!(text || opts.name)) {
        console.error("Provide --text, --file, or --name to update.");
        process.exit(1);
      }

      await client.patch(`/api/cli/contexts/${contextId}`, {
        name: opts.name,
        text,
      });

      console.log(`Updated spec: ${contextId}`);
    });

  // ── sync ──────────────────────────────────────────────────────────────
  spec
    .command("sync <contextId>")
    .description("Trigger spec ↔ task DAG synchronization")
    .action(async (contextId: string) => {
      const client = getClient();

      // First verify this is a spec document
      const ctx = (await client.get(`/api/cli/contexts/${contextId}`)) as Record<string, unknown>;

      if (!ctx.isSpecDocument) {
        console.error("Context is not a spec document. Use `prim context` instead.");
        process.exit(1);
      }

      await client.post(`/api/cli/contexts/${contextId}/sync`);

      console.log(`Triggered sync for spec: ${contextId}`);
      if (ctx.specRootTaskId) {
        console.log(`Root task: ${ctx.specRootTaskId}`);
      }
    });

  // ── map ───────────────────────────────────────────────────────────────
  spec
    .command("map <contextId>")
    .description("Map file patterns to a spec (used by pre-commit hook to detect affected specs)")
    .requiredOption(
      "-p, --pattern <patterns...>",
      'Glob pattern(s) to associate, e.g. "src/auth/**"',
    )
    .action(async (contextId: string, opts: { pattern: string[] }) => {
      const client = getClient();
      const result = (await client.post(`/api/cli/contexts/${contextId}/map`, {
        patterns: opts.pattern,
      })) as { filePatterns: string[] };

      console.log(`Mapped patterns to spec ${contextId}:`);
      for (const p of result.filePatterns) {
        console.log(`  ${p}`);
      }
    });

  // ── unmap ─────────────────────────────────────────────────────────────
  spec
    .command("unmap <contextId>")
    .description("Remove file pattern mappings from a spec (omit --pattern to clear all)")
    .option("-p, --pattern <patterns...>", "Specific pattern(s) to remove (omit to clear all)")
    .action(async (contextId: string, opts: { pattern?: string[] }) => {
      const client = getClient();
      const result = (await client.post(`/api/cli/contexts/${contextId}/unmap`, {
        patterns: opts.pattern,
      })) as { filePatterns: string[] };

      if (result.filePatterns.length === 0) {
        console.log(`Cleared all file patterns from spec ${contextId}`);
      } else {
        console.log(`Updated patterns for spec ${contextId}:`);
        for (const p of result.filePatterns) {
          console.log(`  ${p}`);
        }
      }
    });

  // ── import-mappings ───────────────────────────────────────────────────
  spec
    .command("import-mappings")
    .description(
      "Import specMappings from .primrc.json to server-side storage (one-time migration)",
    )
    .option("--config <path>", "Path to .primrc.json", ".primrc.json")
    .option("--dry-run", "Show what would be imported without making changes")
    .action(async (opts: { config: string; dryRun?: boolean }) => {
      const configPath = resolve(process.cwd(), opts.config);
      if (!existsSync(configPath)) {
        console.error(`Config file not found: ${configPath}`);
        process.exit(1);
      }

      const content = readFileSync(configPath, "utf-8");
      const config = JSON.parse(content) as {
        specMappings?: Array<{ filePattern: string; contextId: string }>;
      };
      const mappings = config.specMappings ?? [];

      if (mappings.length === 0) {
        console.log("No specMappings found in config file.");
        return;
      }

      // Group by contextId
      const byContext = new Map<string, string[]>();
      for (const m of mappings) {
        const patterns = byContext.get(m.contextId) ?? [];
        patterns.push(m.filePattern);
        byContext.set(m.contextId, patterns);
      }

      const client = getClient();
      for (const [contextId, patterns] of byContext) {
        if (opts.dryRun) {
          console.log(`[dry-run] Would map to ${contextId}: ${patterns.join(", ")}`);
          continue;
        }
        await client.post(`/api/cli/contexts/${contextId}/map`, { patterns });
        console.log(`Mapped ${String(patterns.length)} pattern(s) to ${contextId}`);
      }

      if (!opts.dryRun) {
        console.log("\nDone. You can now remove specMappings from your .primrc.json.");
      }
    });
}

function printSpec(ctx: Record<string, unknown>) {
  const name = ctx.name ?? ctx.title ?? "(unnamed)";
  const review = ctx.specReviewStatus ?? "—";
  const patterns = ctx.filePatterns as string[] | undefined;

  console.log(`ID:              ${ctx._id}`);
  console.log(`Name:            ${name}`);
  console.log(`Scope:           ${ctx.scope ?? "task"}`);
  console.log(`Review Status:   ${review}`);
  console.log(`Root Task:       ${ctx.specRootTaskId ?? "—"}`);
  console.log(`Sync Version:    ${ctx.syncVersion ?? 0}`);
  console.log(`Index Status:    ${ctx.indexStatus ?? "—"}`);
  console.log(`File Patterns:   ${patterns?.length ? patterns.join(", ") : "—"}`);

  if (ctx.text) {
    const text = ctx.text as string;
    const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    console.log(`\n--- Text ---\n${preview}`);
  }
}
