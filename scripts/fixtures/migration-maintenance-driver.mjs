// Process fixture: production code, real filesystem, real HTTP; no substituted functions.
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { flush, flushForMaintenance } from "../../src/flusher.ts";
import { deliverPostToolMove } from "../../src/hooks/post-tool-delivery.ts";
import { appendMove } from "../../src/journal.ts";
import { stageHookRuntime } from "../../src/lib/hook-runtime.ts";
import {
  releaseMaintenanceHandoff,
  reportMaintenancePause,
  reserveMaintenanceHandoff,
  withMaintenanceActivity,
  withPausedMaintenance,
} from "../../src/lib/migration-maintenance.ts";
const move = {
  moveId: randomUUID(),
  capturedAt: Date.now(),
  sessionId: "maintenance-e2e",
  eventType: "PostToolUse",
  payload: { tool_name: "Read", tool_input: { file_path: "fixture" } },
  env: { cwd: "/fixture", cliVersion: "0.1.0", osPlatform: process.platform },
  envelopeVersion: 1,
};
const emit = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const hold = async () => {
  emit({ held: true });
  await once(process.stdin, "data");
  process.stdin.pause();
};
try {
  switch (process.argv[2]) {
    case "stage": {
      const staged = stageHookRuntime({
        sourceDir: process.argv[3],
        version: process.argv[4],
        nodePath: process.execPath,
      });
      emit({ releaseDir: staged.releaseDir });
      break;
    }
    case "append":
      for (let i = 0; i < Number(process.argv[3] ?? 1); i++)
        appendMove({ ...move, moveId: randomUUID() }, "org_fixture");
      emit({ captured: true });
      break;
    case "deliver":
      emit(await deliverPostToolMove(move, "org_fixture"));
      break;
    case "hold":
      await withMaintenanceActivity("direct-upload", hold);
      break;
    case "transaction":
      await withPausedMaintenance(process.argv[3], hold);
      break;
    case "nested":
      await withMaintenanceActivity("direct-upload", async () => {
        await hold();
        appendMove(move, "org_fixture");
      });
      break;
    case "reserve":
      await withPausedMaintenance(process.argv[3], async () => {
        reserveMaintenanceHandoff(process.argv[3], "a".repeat(32), process.argv[4]);
        await hold();
      });
      break;
    case "release":
      await withPausedMaintenance(process.argv[3], async () => {
        releaseMaintenanceHandoff(process.argv[3], "a".repeat(32), process.argv[4]);
      });
      break;
    case "flush":
      emit(await flush());
      break;
    case "wrong-id": {
      const normal = flush();
      const rejected = await flushForMaintenance("0".repeat(32)).then(
        () => false,
        () => true,
      );
      await normal;
      emit({ rejected });
      break;
    }
    default:
      throw new Error("Unknown process fixture operation");
  }
} catch (error) {
  reportMaintenancePause(error);
  emit({ error: error.name });
  process.exitCode = 1;
}
