/**
 * Decision Event Pipeline — local NDJSON journal.
 *
 * One append-only file at ~/.config/prim/moves/journal.ndjson. Hooks
 * append a single line; the flusher rotates it aside and removes it on a
 * successful drain.
 *
 * The journal holds raw hook payloads (file contents, prompts, tool I/O),
 * so the file is created 0600 and its directory 0700 — the same posture
 * the CLI uses for its other credential-bearing files.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Move } from "./protocol/move.js";

const JOURNAL_DIR = join(homedir(), ".config", "prim", "moves");
export const JOURNAL_PATH = join(JOURNAL_DIR, "journal.ndjson");

const DIR_MODE = 0o700;
const FILE_MODE = 0o600;

export function appendMoveToPath(path: string, move: Move): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: DIR_MODE });
  }
  appendFileSync(path, `${JSON.stringify(move)}\n`, { mode: FILE_MODE });
}

export function appendMove(move: Move): void {
  appendMoveToPath(JOURNAL_PATH, move);
}

export function readMovesFromPath(path: string): Move[] {
  if (!existsSync(path)) {
    return [];
  }
  const content = readFileSync(path, "utf-8");
  const moves: Move[] = [];
  for (const line of content.split("\n")) {
    if (line.length === 0) {
      continue;
    }
    try {
      moves.push(JSON.parse(line) as Move);
    } catch {
      // Skip malformed lines rather than abort the drain.
    }
  }
  return moves;
}

export function readMoves(): Move[] {
  return readMovesFromPath(JOURNAL_PATH);
}

export type JournalStats = {
  sizeBytes: number;
  mtimeMs: number;
  lineCount: number;
};

export function journalStats(): JournalStats | null {
  if (!existsSync(JOURNAL_PATH)) {
    return null;
  }
  const stat = statSync(JOURNAL_PATH);
  const content = readFileSync(JOURNAL_PATH, "utf-8");
  const lineCount = content.split("\n").filter((l) => l.length > 0).length;
  return {
    sizeBytes: stat.size,
    mtimeMs: stat.mtimeMs,
    lineCount,
  };
}
