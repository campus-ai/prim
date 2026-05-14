/**
 * Spec commands for the prim CLI.
 *
 * Specs are contexts with isSpecDocument=true. These commands provide
 * spec-specific views and operations on top of the unified context API.
 *
 * prim spec list [--project-id <id>]
 * prim spec get <context-id>
 * prim spec create --scope <scope> --name <name> [--branch <branch>] [--pr <pr>]
 * prim spec update <context-id> --text <text> | --file <path>
 * prim spec sync <context-id>
 */

import { readFileSync } from "node:fs";
import type { Command } from "commander";
import { getClient } from "../client.js";
import { printJson } from "../output.js";
import { getGitContext } from "../utils/git.js";

export function registerSpecCommands(program: Command) {
  const spec = program.command("spec").description("Manage spec documents");

  // ── list ──────────────────────────────────────────────────────────────
  spec
    .command("list")
    .description("List spec documents")
    .option("-t, --project-id <projectId>", "List spec for a specific root project")
    .option("--json", "Output as JSON")
    .action(async (opts: { projectId?: string; json?: boolean }) => {
      const client = getClient();

      if (opts.projectId) {
        const specs = (await client.get(`/api/cli/specs?rootTaskId=${opts.projectId}`)) as Array<
          Record<string, unknown>
        >;

        if (opts.json) {
          printJson(specs[0] ?? null);
          return;
        }

        if (specs.length === 0) {
          console.error("No spec document found for this project.");
          return;
        }

        printSpec(specs[0]);
        return;
      }

      // List all spec documents
      const contexts = (await client.get("/api/cli/specs")) as Array<Record<string, unknown>>;

      if (opts.json) {
        printJson(contexts);
        return;
      }

      if (contexts.length === 0) {
        console.error("No spec documents found.");
        return;
      }

      for (const ctx of contexts) {
        const scope =
          (ctx.scope as string) === "task" ? "project" : ((ctx.scope as string) ?? "project");
        const review = ctx.specReviewStatus ?? "—";
        const name = ctx.name ?? "(unnamed)";
        console.log(`${ctx._id}  ${scope.padEnd(8)} ${String(review).padEnd(10)} ${name}`);
      }
      console.error(`\n${contexts.length} spec(s)`);
    });

  // ── get ───────────────────────────────────────────────────────────────
  spec
    .command("get <contextId>")
    .description("Get a spec document by ID")
    .option("--text-only", "Print only the text content (no metadata)")
    .option("--json", "Output as JSON (overrides --text-only)")
    .action(async (contextId: string, opts: { textOnly?: boolean; json?: boolean }) => {
      const client = getClient();
      const ctx = (await client.get(`/api/cli/contexts/${contextId}`)) as Record<string, unknown>;

      if (opts.json) {
        printJson(ctx);
        return;
      }

      if (opts.textOnly) {
        console.log((ctx.text as string) ?? "");
        return;
      }

      printSpec(ctx);
    });

  // ── create ────────────────────────────────────────────────────────────
  spec
    .command("create")
    .description("Create a new spec document")
    .requiredOption("-s, --scope <scope>", "Scope: project, global, external")
    .requiredOption("-n, --name <name>", "Spec name")
    .option("-t, --text <text>", "Spec text content")
    .option("-f, --file <path>", "Read text content from file")
    .option("--project-id <projectId>", "Link to project(s), comma-separated")
    .option("--branch <branch>", "Link spec to this branch on the current repo")
    .option("--pr <prNumber>", "Optional PR number to attach to the link")
    .option("--json", "Output as JSON")
    .action(
      async (opts: {
        scope: string;
        name: string;
        text?: string;
        file?: string;
        projectId?: string;
        branch?: string;
        pr?: string;
        json?: boolean;
      }) => {
        const client = getClient();

        let text = opts.text;
        if (opts.file) {
          text = readFileSync(opts.file, "utf-8");
        }

        const taskIds = opts.projectId
          ? opts.projectId.split(",").map((id) => id.trim())
          : undefined;

        let linkedBranch: { repoFullName: string; branch: string; prNumber?: number } | undefined;
        if (opts.branch) {
          const { repoFullName } = getGitContext();
          if (!repoFullName) {
            console.warn(
              "[prim] --branch supplied but origin remote is not GitHub; skipping link.",
            );
          } else {
            linkedBranch = { repoFullName, branch: opts.branch };
            if (opts.pr) {
              const n = Number.parseInt(opts.pr, 10);
              if (Number.isFinite(n)) linkedBranch.prNumber = n;
            }
          }
        }

        const result = (await client.post("/api/cli/contexts", {
          scope: opts.scope === "project" ? "task" : opts.scope,
          name: opts.name,
          text,
          taskIds,
          isSpecDocument: true,
          linkedBranch,
        })) as { _id: string };

        if (opts.json) {
          printJson({ _id: result._id });
          return;
        }

        console.error(
          `Created spec: ${result._id}${linkedBranch ? ` (linked to ${linkedBranch.branch})` : ""}`,
        );
        console.log(result._id);
      },
    );

  // ── update ────────────────────────────────────────────────────────────
  spec
    .command("update <contextId>")
    .description("Update a spec document's text content")
    .option("-t, --text <text>", "New text content")
    .option("-f, --file <path>", "Read text content from file")
    .option("-n, --name <name>", "New name")
    .option("--json", "Output as JSON")
    .action(
      async (
        contextId: string,
        opts: { text?: string; file?: string; name?: string; json?: boolean },
      ) => {
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
          skipTiptapLifecycle: !!text,
        });

        // Inject content into the TipTap Y.Doc to preserve version history
        if (text) {
          await client.post(`/api/cli/contexts/${contextId}/inject`);
        }

        if (opts.json) {
          printJson({ _id: contextId });
          return;
        }

        console.error(`Updated spec: ${contextId}`);
        console.log(contextId);
      },
    );

  // ── sync ──────────────────────────────────────────────────────────────
  spec
    .command("sync <contextId>")
    .description("Trigger spec ↔ project DAG synchronization")
    .option("--json", "Output as JSON")
    .action(async (contextId: string, opts: { json?: boolean }) => {
      const client = getClient();

      // First verify this is a spec document
      const ctx = (await client.get(`/api/cli/contexts/${contextId}`)) as Record<string, unknown>;

      if (!ctx.isSpecDocument) {
        console.error("Context is not a spec document. Use `prim context` instead.");
        process.exit(1);
      }

      await client.post(`/api/cli/contexts/${contextId}/sync`);

      if (opts.json) {
        printJson(
          ctx.specRootTaskId
            ? { _id: contextId, specRootTaskId: ctx.specRootTaskId }
            : { _id: contextId },
        );
        return;
      }

      console.error(`Triggered sync for spec: ${contextId}`);
      if (ctx.specRootTaskId) {
        console.error(`Root project: ${ctx.specRootTaskId}`);
      }
      console.log(contextId);
    });

  // ── review ────────────────────────────────────────────────────────────
  spec
    .command("review <contextId>")
    .description("Manually trigger the PR Intent Review bot for a spec")
    .requiredOption("--pr <prNumber>", "PR number to review against")
    .option("--sha <headSha>", "Commit SHA the review runs against (defaults to current HEAD)")
    .action(async (contextId: string, opts: { pr: string; sha?: string }) => {
      const prNumber = Number.parseInt(opts.pr, 10);
      if (!Number.isFinite(prNumber)) {
        console.error("--pr must be an integer.");
        process.exit(1);
      }
      const headSha = opts.sha ?? getGitContext().sha;
      if (!headSha) {
        console.error("Could not determine head SHA — pass --sha or run inside a git checkout.");
        process.exit(1);
      }

      const client = getClient();
      await client.post(`/api/cli/contexts/${contextId}/review`, {
        prNumber,
        headSha,
      });

      console.log(
        `Scheduled review: ${contextId} against PR #${String(prNumber)} @ ${headSha.slice(0, 7)}`,
      );
    });

  // ── drift ─────────────────────────────────────────────────────────────
  spec
    .command("drift <contextId>")
    .description("Dispatch the Claude Code drift-fix workflow against a PR")
    .requiredOption("--pr <prNumber>", "PR number to dispatch the drift-fix workflow against")
    .action(async (contextId: string, opts: { pr: string }) => {
      const prNumber = Number.parseInt(opts.pr, 10);
      if (!Number.isFinite(prNumber)) {
        console.error("--pr must be an integer.");
        process.exit(1);
      }

      const client = getClient();
      const result = (await client.post(`/api/cli/contexts/${contextId}/drift`, {
        prNumber,
      })) as { dispatched: boolean; runUrl?: string };

      if (result.dispatched) {
        const ref = result.runUrl ? `: ${result.runUrl}` : "";
        console.log(`Dispatched drift-fix workflow${ref}`);
      } else {
        console.error(
          "Drift-fix dispatch failed. Likely causes: actions:write App scope not granted, primitive-drift-fix.yml workflow file missing, or no findings on the latest review.",
        );
        process.exit(1);
      }
    });

  // ── status ────────────────────────────────────────────────────────────
  spec
    .command("status <taskId>")
    .description(
      "Show task status, auto-complete suppression flag, and the most-recent bot auto-completion",
    )
    .action(async (taskId: string) => {
      const client = getClient();
      const result = (await client.get(`/api/cli/tasks/${taskId}/status`)) as {
        status: string;
        autoCompleteSuppressed: boolean;
        lastAutoCompleteActivity?: {
          createdAt?: number;
          explanation: string;
          prNumber?: number;
        };
      };

      console.log(`status: ${result.status}`);
      console.log(`auto-complete suppressed: ${result.autoCompleteSuppressed ? "yes" : "no"}`);
      const last = result.lastAutoCompleteActivity;
      if (last) {
        const when = last.createdAt ? new Date(last.createdAt).toISOString() : "—";
        const pr = last.prNumber ? `#${String(last.prNumber)}` : "—";
        console.log(`last auto-complete: ${when} (PR ${pr})`);
        if (last.explanation) {
          console.log(`  ${last.explanation}`);
        }
      } else {
        console.log("last auto-complete: —");
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
    .option("--json", "Output as JSON")
    .action(async (contextId: string, opts: { pattern: string[]; json?: boolean }) => {
      const client = getClient();
      const result = (await client.post(`/api/cli/contexts/${contextId}/map`, {
        patterns: opts.pattern,
      })) as { filePatterns: string[] };

      if (opts.json) {
        printJson({ _id: contextId, filePatterns: result.filePatterns });
        return;
      }

      console.error(`Mapped patterns to spec ${contextId}:`);
      for (const p of result.filePatterns) {
        console.error(`  ${p}`);
      }
      console.log(contextId);
    });

  // ── unmap ─────────────────────────────────────────────────────────────
  spec
    .command("unmap <contextId>")
    .description("Remove file pattern mappings from a spec (omit --pattern to clear all)")
    .option("-p, --pattern <patterns...>", "Specific pattern(s) to remove (omit to clear all)")
    .option("--json", "Output as JSON")
    .action(async (contextId: string, opts: { pattern?: string[]; json?: boolean }) => {
      const client = getClient();
      const result = (await client.post(`/api/cli/contexts/${contextId}/unmap`, {
        patterns: opts.pattern,
      })) as { filePatterns: string[] };

      if (opts.json) {
        printJson({ _id: contextId, filePatterns: result.filePatterns });
        return;
      }

      if (result.filePatterns.length === 0) {
        console.error(`Cleared all file patterns from spec ${contextId}`);
      } else {
        console.error(`Updated patterns for spec ${contextId}:`);
        for (const p of result.filePatterns) {
          console.error(`  ${p}`);
        }
      }
      console.log(contextId);
    });

  // ── auto-map ─────────────────────────────────────────────────────────
  spec
    .command("auto-map <contextId>")
    .description("Trigger auto-mapping of file patterns for a spec")
    .option("--json", "Output as JSON")
    .action(async (contextId: string, opts: { json?: boolean }) => {
      const client = getClient();
      await client.post(`/api/cli/contexts/${contextId}/auto-map`);

      if (opts.json) {
        printJson({ _id: contextId });
        return;
      }

      console.error(`Auto-mapping triggered for spec: ${contextId}`);
      console.log(contextId);
    });
}

function printSpec(ctx: Record<string, unknown>) {
  const name = ctx.name ?? ctx.title ?? "(unnamed)";
  const review = ctx.specReviewStatus ?? "—";
  const patterns = ctx.filePatterns as string[] | undefined;

  console.log(`ID:              ${ctx._id}`);
  console.log(`Name:            ${name}`);
  console.log(`Scope:           ${ctx.scope === "task" ? "project" : (ctx.scope ?? "project")}`);
  console.log(`Review Status:   ${review}`);
  console.log(`Root Project:    ${ctx.specRootTaskId ?? "—"}`);
  console.log(`Sync Version:    ${ctx.syncVersion ?? 0}`);
  console.log(`Index Status:    ${ctx.indexStatus ?? "—"}`);
  console.log(`File Patterns:   ${patterns?.length ? patterns.join(", ") : "—"}`);

  if (ctx.text) {
    const text = ctx.text as string;
    const preview = text.length > 500 ? `${text.slice(0, 500)}…` : text;
    console.log(`\n--- Text ---\n${preview}`);
  }
}
