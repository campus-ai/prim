/** Explicit drain-first preparation. Never imports credentials or switches hooks. */
import type { Command } from "commander";
import { type FlushResult, flushForMaintenance } from "../flusher.js";
import {
  maintenanceStatus,
  pauseMaintenance,
  resumeMaintenance,
} from "../lib/migration-maintenance.js";

function emit(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}
async function guarded(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    const message = error instanceof Error ? error.message : "Migration operation failed";
    process.stderr.write(`[prim] ${message}\n`);
    emit({ protocolVersion: 1, error: "migration_operation_failed", message });
    process.exitCode = 1;
  }
}

export function registerMigrationCommands(program: Command): void {
  const migration = program
    .command("migration")
    .description("Prepare a cooperative drain-first legacy handoff");
  migration
    .command("pause")
    .description("Persist a capture/delivery pause and wait for admitted operations")
    .option(
      "--timeout-ms <milliseconds>",
      "Wait at most 0..30000 ms for earlier operations",
      "5000",
    )
    .action((options: { timeoutMs: string }) =>
      guarded(async () => {
        if (!/^(?:0|[1-9][0-9]{0,4})$/.test(options.timeoutMs))
          throw new Error("Maintenance timeout must be 0..30000 ms");
        const status = await pauseMaintenance(Number(options.timeoutMs));
        emit(status);
        process.stderr.write(
          status.quiescent
            ? "[prim] Legacy writers/drainers paused; older sessions must still be ended.\n"
            : "[prim] Pause persisted; admitted activity remains. Retry status before draining.\n",
        );
        if (!status.quiescent) process.exitCode = 1;
      }),
    );
  migration
    .command("status")
    .description("Inspect pause, admitted operations and every queue partition")
    .option("--id <maintenance-id>", "Require the matching pause identity")
    .action((options: { id?: string }) =>
      guarded(async () => {
        emit(await maintenanceStatus(options.id));
      }),
    );
  migration
    .command("ready")
    .description("Require the matching pause, no admitted activity and completely empty queues")
    .requiredOption("--id <maintenance-id>", "Pause identity")
    .action((options: { id: string }) =>
      guarded(async () => {
        const status = await maintenanceStatus(options.id);
        emit(status);
        if (!status.ready) {
          process.stderr.write(
            "[prim] Handoff refused: legacy queues or admitted activity remain unresolved.\n",
          );
          process.exitCode = 1;
        }
      }),
    );
  migration
    .command("drain")
    .description(
      "Drain with existing authority for the current API; retain the pause and inspect all partitions",
    )
    .requiredOption("--id <maintenance-id>", "Pause identity")
    .action((options: { id: string }) =>
      guarded(async () => {
        if (!(await maintenanceStatus(options.id)).quiescent)
          throw new Error("Wait for admitted operations before maintenance drain");
        let drain: FlushResult;
        try {
          drain = await flushForMaintenance(options.id);
        } catch {
          emit({
            ...(await maintenanceStatus(options.id)),
            drain: { completed: false, error: "legacy_drain_failed" },
          });
          process.stderr.write(
            "[prim] Legacy drain did not complete; data and maintenance pause remain in place.\n",
          );
          process.exitCode = 1;
          return;
        }
        const status = await maintenanceStatus(options.id);
        emit({ ...status, drain });
        if (drain.skipped || !status.ready) {
          process.stderr.write(
            "[prim] Drain is not a handoff certificate: unresolved queues/activity remain.\n",
          );
          process.exitCode = 1;
        }
      }),
    );
  migration
    .command("resume")
    .description("Explicitly remove only the matching pause; retain all journals and credentials")
    .requiredOption("--id <maintenance-id>", "Pause identity")
    .action((options: { id: string }) =>
      guarded(async () => {
        emit(await resumeMaintenance(options.id));
      }),
    );
}
