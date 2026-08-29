/**
 * Decision Event Pipeline — `prim moves` subcommand.
 *
 *   prim moves flush   — drain all per-bucket journals to the server
 *   prim moves status  — per-bucket pending stats
 *   prim moves tail    — pretty-print recent journal entries (any bucket)
 *   prim moves bind    — write `.prim/workspace.json` pinning cwd to an org
 *   prim moves drop    — remove `.prim/workspace.json` from cwd
 *
 * Tail reads the local journals directly (not the server), so it works
 * offline and shows pre-flush state — useful when debugging "did the
 * hook actually fire?" before any network round-trip is involved.
 */

import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command } from "commander";
import { flush } from "../flusher.js";
import { JOURNAL_DIR, bucketStats, listFlushing, readMovesFromPath } from "../journal.js";

const MS_PER_SECOND = 1000;
const DEFAULT_TAIL_LINES = "20";
const RADIX_DECIMAL = 10;
const ID_PREFIX_LEN = 8;
const EVENT_COL_WIDTH = 20;
const BUCKET_COL_WIDTH = 20;
const TAIL_BUCKET_COL_WIDTH = 12;
const DIR_MODE = 0o700;
const FILE_MODE = 0o600;
const WORKSPACE_FILE = ".prim/workspace.json";

export function registerMovesCommands(program: Command): void {
  const moves = program.command("moves").description("Decision Event Pipeline — local journal");

  moves
    .command("flush")
    .description("Drain all local move journals to the server")
    .action(async () => {
      const { flushed, quarantined, retained = [], skipped } = await flush();
      if (skipped) {
        console.log("[prim] another flush is already draining; moves left journaled");
        return;
      }
      console.log(`[prim] flushed ${String(flushed)} move${flushed === 1 ? "" : "s"}`);
      if (quarantined > 0) {
        console.error(
          `[prim] quarantined ${String(quarantined)} rejected move${quarantined === 1 ? "" : "s"}; inspect the bucket's dead-letter directory`,
        );
      }
      const retainedReasons = new Map<string, number>();
      for (const item of retained) {
        retainedReasons.set(item.reason, (retainedReasons.get(item.reason) ?? 0) + 1);
      }
      for (const [reason, count] of [...retainedReasons].sort(([left], [right]) =>
        left.localeCompare(right),
      )) {
        console.error(`[prim] retained ${String(count)} organization bucket(s): ${reason}`);
      }
      if (retained.length > 0 && !process.exitCode) {
        process.exitCode = 1;
      }
    });

  moves
    .command("status")
    .description("Show per-bucket pending stats")
    .action(() => {
      const stats = bucketStats();
      const stranded = listFlushing();
      // Only truly empty when there is neither pending nor stranded state —
      // a machine whose only journal artifact is an orphaned `.flushing` must
      // not read as "empty".
      if (stats.length === 0 && stranded.length === 0) {
        console.log("[prim] journal: empty");
        return;
      }
      console.log(`[prim] root: ${JOURNAL_DIR}`);
      for (const s of stats) {
        const ageS = Math.round((Date.now() - s.mtimeMs) / MS_PER_SECOND);
        const count = `${String(s.lineCount)}${s.sampled ? "+" : ""}`;
        console.log(
          `  ${s.bucket.padEnd(BUCKET_COL_WIDTH)} ${count.padStart(5)} pending, ${String(s.sizeBytes).padStart(8)} bytes, last write ${String(ageS)}s ago`,
        );
      }
      if (stranded.length > 0) {
        const moveCount = stranded.reduce((n, f) => n + f.lineCount, 0);
        const byteCount = stranded.reduce((n, f) => n + f.sizeBytes, 0);
        const sampled = stranded.some((file) => file.sampled);
        const qualifier = sampled ? "at least " : "";
        console.log(
          `[prim] ⚠ ${String(stranded.length)} stranded flush file(s): ${qualifier}${String(moveCount)} move(s), ${String(byteCount)} bytes — recover with \`prim moves flush\``,
        );
        for (const f of stranded) {
          const ageS = Math.round((Date.now() - f.mtimeMs) / MS_PER_SECOND);
          const owner = f.pid === undefined ? "no pid" : `pid ${String(f.pid)}`;
          const count = `${String(f.lineCount)}${f.sampled ? "+" : ""}`;
          console.log(
            `  ${f.bucket.padEnd(BUCKET_COL_WIDTH)} ${count.padStart(5)} stranded, ${String(f.sizeBytes).padStart(8)} bytes, ${String(ageS)}s ago (${owner})`,
          );
        }
      }
    });

  moves
    .command("tail")
    .description("Pretty-print recent journal entries across all buckets")
    .option("-n, --lines <n>", "number of lines to tail", DEFAULT_TAIL_LINES)
    .action((opts: { lines: string }) => {
      const lines = Number.parseInt(opts.lines, RADIX_DECIMAL);
      if (!Number.isInteger(lines) || lines < 1) {
        console.error("[prim] --lines must be a positive integer");
        process.exitCode = 1;
        return;
      }
      const all = bucketStats()
        .flatMap((s) => readMovesFromPath(s.path).map((m) => ({ bucket: s.bucket, move: m })))
        .sort((a, b) => a.move.capturedAt - b.move.capturedAt);
      if (all.length === 0) {
        console.log("[prim] journal: empty");
        return;
      }
      const tail = all.slice(-lines);
      for (const { bucket, move: m } of tail) {
        const t = new Date(m.capturedAt).toISOString();
        const session = m.sessionId.slice(0, ID_PREFIX_LEN) || "anon";
        const move = m.moveId.slice(0, ID_PREFIX_LEN);
        console.log(
          `${t}  ${m.eventType.padEnd(EVENT_COL_WIDTH)} bucket=${bucket.padEnd(TAIL_BUCKET_COL_WIDTH)} session=${session}  move=${move}`,
        );
      }
    });

  moves
    .command("bind")
    .description("Pin the current directory to an org via .prim/workspace.json")
    .requiredOption("--orgId <orgId>", "Convex organization id")
    .action((opts: { orgId: string }) => {
      const dir = join(process.cwd(), ".prim");
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: DIR_MODE });
      }
      const file = join(process.cwd(), WORKSPACE_FILE);
      writeFileSync(file, JSON.stringify({ orgId: opts.orgId, boundAt: Date.now() }, null, 2), {
        mode: FILE_MODE,
      });
      console.log(`[prim] bound ${process.cwd()} to org ${opts.orgId}`);
    });

  moves
    .command("drop")
    .description("Remove the .prim/workspace.json binding from the cwd")
    .action(() => {
      const file = join(process.cwd(), WORKSPACE_FILE);
      if (!existsSync(file)) {
        console.log("[prim] no workspace binding in cwd");
        return;
      }
      unlinkSync(file);
      console.log(`[prim] dropped workspace binding from ${process.cwd()}`);
    });
}
