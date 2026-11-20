import type { Command } from "commander";
import { changeHandoff, handoffStatus, prepareHandoff } from "../lib/migration-handoff.js";

export function registerHandoffCommands(migration: Command): void {
  const group = migration
    .command("handoff")
    .description("Prepare, apply or reverse an explicitly reviewed native maintenance handoff");
  async function execute(action: () => unknown | Promise<unknown>): Promise<void> {
    try {
      process.stdout.write(`${JSON.stringify(await action())}\n`);
    } catch (error) {
      const message = error instanceof Error ? error.message : "Native handoff failed";
      process.stderr.write(`[prim] ${message}\n`);
      process.stdout.write(
        `${JSON.stringify({ protocolVersion: 1, error: "handoff_held", message })}\n`,
      );
      process.exitCode = 1;
    }
  }
  group
    .command("prepare")
    .requiredOption("--spec <file>", "Private reviewed handoff specification")
    .requiredOption("--transaction <directory>", "New private snapshot directory")
    .action((options: { spec: string; transaction: string }) =>
      execute(() => prepareHandoff(options.spec, options.transaction)),
    );
  for (const direction of ["apply", "rollback"] as const)
    group
      .command(direction)
      .requiredOption("--transaction <directory>", "Prepared private transaction directory")
      .action((options: { transaction: string }) =>
        execute(() => changeHandoff(options.transaction, direction)),
      );
  group
    .command("status")
    .requiredOption("--transaction <directory>", "Private transaction directory")
    .action((options: { transaction: string }) =>
      execute(() => handoffStatus(options.transaction)),
    );
}
