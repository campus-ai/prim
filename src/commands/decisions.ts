/**
 * `prim decisions` commands.
 *
 *   prim decisions check --files=path1,path2     (warn-only file → decisions lookup)
 *   prim decisions recent [--limit=N] [--since=DUR]
 *   prim decisions show <idOrShortId>
 *   prim decisions cascade <idOrShortId>
 *   prim decisions confirm <idOrShortId> [--reject]
 *
 * The `decisions` command group is created once here; every subcommand
 * attaches to this same group. AX contract throughout: STDOUT is always
 * machine-readable JSON, STDERR is verdict-first human text, exit 0 on
 * success (including an idempotent no-op such as already-acknowledged);
 * non-zero only on auth/network failure or not-found for show/cascade/
 * confirm. The `checkAffectedDecisions` helper backs both `check` and the
 * pre-commit hook (src/hooks/pre-commit.ts).
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
    .description("Acknowledge a confirmation prompt for the named decision")
    .option("--reject", "Record a rejection (sets the decision's confirmed flag to false)")
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
