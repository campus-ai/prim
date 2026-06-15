/**
 * Decision Event Pipeline — `prim moves` subcommand.
 *
 *   prim moves flush   — drain local journal to server
 *   prim moves status  — show pending journal stats
 *   prim moves tail    — pretty-print recent journal entries
 *
 * Tail reads the local journal directly (not the server), so it works
 * offline and shows pre-flush state — useful when debugging "did the
 * hook actually fire?" before any network round-trip is involved.
 */

import type { Command } from "commander";
import { flush } from "../flusher.js";
import { JOURNAL_PATH, journalStats, readMoves } from "../journal.js";

const MS_PER_SECOND = 1000;
const DEFAULT_TAIL_LINES = "20";
const RADIX_DECIMAL = 10;
const ID_PREFIX_LEN = 8;
const EVENT_COL_WIDTH = 20;

export function registerMovesCommands(program: Command): void {
  const moves = program.command("moves").description("Decision Event Pipeline — local journal");

  moves
    .command("flush")
    .description("Drain the local move journal to the server")
    .action(async () => {
      const { flushed } = await flush();
      console.log(`[prim] flushed ${String(flushed)} move${flushed === 1 ? "" : "s"}`);
    });

  moves
    .command("status")
    .description("Show pending journal stats")
    .action(() => {
      const stats = journalStats();
      if (!stats) {
        console.log("[prim] journal: empty");
        return;
      }
      const ageS = Math.round((Date.now() - stats.mtimeMs) / MS_PER_SECOND);
      console.log(
        `[prim] journal: ${String(stats.lineCount)} pending, ${String(stats.sizeBytes)} bytes, last write ${String(ageS)}s ago`,
      );
      console.log(`[prim] path: ${JOURNAL_PATH}`);
    });

  moves
    .command("tail")
    .description("Pretty-print recent journal entries")
    .option("-n, --lines <n>", "number of lines to tail", DEFAULT_TAIL_LINES)
    .action((opts: { lines: string }) => {
      const lines = Number.parseInt(opts.lines, RADIX_DECIMAL);
      if (!Number.isInteger(lines) || lines < 1) {
        console.error("[prim] --lines must be a positive integer");
        process.exitCode = 1;
        return;
      }
      const all = readMoves();
      if (all.length === 0) {
        console.log("[prim] journal: empty");
        return;
      }
      const tail = all.slice(-lines);
      for (const m of tail) {
        const t = new Date(m.capturedAt).toISOString();
        const session = m.sessionId.slice(0, ID_PREFIX_LEN) || "anon";
        const move = m.moveId.slice(0, ID_PREFIX_LEN);
        console.log(
          `${t}  ${m.eventType.padEnd(EVENT_COL_WIDTH)} session=${session}  move=${move}`,
        );
      }
    });
}
