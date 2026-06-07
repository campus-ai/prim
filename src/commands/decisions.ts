/**
 * Decision Event Pipeline commands for the prim CLI.
 *
 * Existing surface (pre-M1):
 *   prim decisions check --files=path1,path2
 *     Reads the Decision Graph for active decisions referencing the
 *     supplied paths. STDERR warning + STDOUT JSON. Warn-only.
 *
 * M1 read surfaces (the CEO's idealized workflow, image #0 + image #1):
 *   prim decisions recent [--limit=N] [--since=DUR]
 *   prim decisions show <idOrShortId>
 *   prim decisions cascade <idOrShortId>
 *   prim decisions confirm <idOrShortId> [--reject]
 *
 * AX contract holds throughout: STDOUT is always machine-readable JSON,
 * STDERR is always verdict-first human text, exit 0 on success
 * (including idempotent no-op like already-acknowledged). Non-zero exit
 * only on auth failure, network failure, or `not found` for show /
 * cascade / confirm. See plan
 * ~/.claude/plans/great-i-d-like-for-joyful-hollerith.md.
 */
import type { Command } from "commander";
import { renderCascade } from "../decisions/cascade-renderer.js";
import { CascadeNotFoundError, fetchCascade, formatCascadeJson } from "../decisions/cascade.js";
import {
  ConfirmNotFoundError,
  fetchConfirm,
  formatConfirmHuman,
  formatConfirmJson,
} from "../decisions/confirm.js";
import { fetchRecent, formatRecentHuman, formatRecentJson } from "../decisions/recent.js";
import {
  DecisionNotFoundError,
  fetchShow,
  formatShowHuman,
  formatShowJson,
} from "../decisions/show.js";
import { checkAffectedDecisions, formatDecisionsWarning } from "../hooks/decisions-check.js";
import { printJson } from "../output.js";

const EXIT_NOT_FOUND = 4;

export function registerDecisionsCommands(program: Command): void {
  const decisions = program.command("decisions").description("Inspect the project Decision Graph");

  decisions
    .command("check")
    .description("Look up active decisions that reference one or more file paths")
    .requiredOption(
      "--files <files>",
      "Comma-separated file paths to check against the Decision Graph",
    )
    .action(async (opts: { files: string }) => {
      const filePaths = opts.files
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      const result = await checkAffectedDecisions(filePaths);
      const warning = formatDecisionsWarning(result);
      if (warning) {
        console.error(warning);
      }
      printJson(result);
    });

  decisions
    .command("recent")
    .description("Show the team-wide chronological decision feed")
    .option("--limit <n>", "Maximum number of rows to return (default 10)")
    .option(
      "--since <duration>",
      "Lookback window — accepts `Nm`, `Nh`, `Nd` (minutes / hours / days) or absolute epoch ms",
    )
    .action(async (opts: { limit?: string; since?: string }) => {
      const result = await fetchRecent({
        limit: opts.limit ? Number.parseInt(opts.limit, 10) : undefined,
        since: opts.since,
      });
      console.error(formatRecentHuman(result));
      console.log(formatRecentJson(result));
    });

  decisions
    .command("show <idOrShortId>")
    .description("Show full detail for one decision (intent, rationale, flags, refs, edges)")
    .action(async (idOrShortId: string) => {
      try {
        const result = await fetchShow(idOrShortId);
        console.error(formatShowHuman(result));
        console.log(formatShowJson(result));
      } catch (err) {
        if (err instanceof DecisionNotFoundError) {
          console.error(`[prim] ${err.message}`);
          process.exitCode = EXIT_NOT_FOUND;
          return;
        }
        throw err;
      }
    });

  decisions
    .command("cascade <idOrShortId>")
    .description("Render the local cascade subgraph (upstream knowledge + downstream dependents)")
    .action(async (idOrShortId: string) => {
      try {
        const result = await fetchCascade(idOrShortId);
        console.error(renderCascade(result));
        console.log(formatCascadeJson(result));
      } catch (err) {
        if (err instanceof CascadeNotFoundError) {
          console.error(`[prim] ${err.message}`);
          process.exitCode = EXIT_NOT_FOUND;
          return;
        }
        throw err;
      }
    });

  decisions
    .command("confirm <idOrShortId>")
    .description("Acknowledge a Phase C confirmation prompt for the named decision")
    .option("--reject", "Confirm rejection (sets decisions.confirmed=false). Defaults to true.")
    .action(async (idOrShortId: string, opts: { reject?: boolean }) => {
      const confirmed = !opts.reject;
      try {
        const result = await fetchConfirm(idOrShortId, confirmed);
        console.error(formatConfirmHuman(result));
        console.log(formatConfirmJson(result));
      } catch (err) {
        if (err instanceof ConfirmNotFoundError) {
          console.error(`[prim] ${err.message}`);
          process.exitCode = EXIT_NOT_FOUND;
          return;
        }
        throw err;
      }
    });
}
