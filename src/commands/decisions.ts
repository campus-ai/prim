/**
 * `prim decisions` commands.
 *
 *   prim decisions check --files=path1,path2
 *
 * Output contract:
 *   STDERR — human warning block (when decisions match, or when the check
 *            could not be verified)
 *   STDOUT — JSON ({ decisions, truncated, unavailable? }) always
 *   exit code — always 0 (warn-only; never blocks the caller)
 *
 * The `decisions` command group is created once here; later `prim decisions`
 * subcommands are added to this same group rather than re-declaring it. The
 * `checkAffectedDecisions` helper backs both this command and the pre-commit
 * hook (src/hooks/pre-commit.ts).
 */
import type { Command } from "commander";
import { checkAffectedDecisions, formatDecisionsWarning } from "../hooks/decisions-check.js";
import { printJson } from "../output.js";

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
}
