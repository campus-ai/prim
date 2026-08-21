/**
 * Resolved-path cache for the session hooks — the write side of the shim's
 * branch-0 (see hookShimCommand in bin-path.ts for the read side).
 *
 * Without it, every hook fire on an un-installed host re-resolves the CLI
 * through `npx --yes -p @primitive.ai/prim@latest`: a full npm process +
 * registry round-trip per Edit (×2 with the gate) + per statusline refresh,
 * which pegs CPU. This records each hook bin's resolved absolute entry (and the
 * node runtime that resolved it) so the shim can `exec node <entry>` directly.
 *
 * Freshness model: a cache HIT execs the cached (possibly older) binary and so
 * cannot discover a newer @latest — only a MISS runs npx. SessionStart is held
 * to the bare ladder (cacheRead:false), so it re-resolves @latest and rewrites
 * this cache once per session; the TTL in the shim is only a backstop for
 * long-lived / SessionStart-less sessions. To keep that working, warmBinCache()
 * MUST NOT run on the hit path (it would bump mtime and freeze the TTL) — hence
 * the PRIM_BIN_CACHE_HIT guard the shim sets before exec.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { binFile } from "./bin-path.js";

// The bins the shim execs directly on a hit — mirrors the cacheRead:true shims
// (capture, gate, ingest, statusline). Any single warm pass writes them all,
// since binFile() reads the whole bin map regardless of which one is running.
const CACHED_BINS = [
  "prim",
  "prim-hook",
  "prim-pre-tool-use",
  "prim-post-tool-use",
  "prim-post-commit",
  "prim-post-rewrite",
] as const;

/**
 * Absolute cache dir. The shell dir expression in bin-path.ts
 * (BIN_CACHE_DIR_SH) MUST mirror this byte-for-byte — a spec pins the pair.
 */
export function binCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "prim", "bin");
}

function writeAtomic(path: string, content: string): void {
  atomicWriteFile(path, content, { mode: 0o600 });
}

/**
 * Persist the resolved bin paths so the shim can skip npx on subsequent fires.
 * A no-op on the cache-hit path (PRIM_BIN_CACHE_HIT) and under the kill switch
 * (PRIM_BIN_CACHE=0), and never throws — a hook must not break because the
 * cache could not be written.
 */
export function warmBinCache(): void {
  try {
    if (process.env.PRIM_BIN_CACHE_HIT) {
      return;
    }
    if (process.env.PRIM_BIN_CACHE === "0") {
      return;
    }
    const dir = binCacheDir();
    // 0o700: the shim execs whatever paths live here with only -x/-f guards, so
    // the dir must not be group/world-writable. mkdir's mode applies only on
    // creation — an existing dir from a laxer umask keeps its old mode, so
    // tighten it explicitly (still inside the fail-open try).
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    writeAtomic(join(dir, "node"), process.execPath);
    for (const bin of CACHED_BINS) {
      const file = binFile(bin);
      if (file) {
        writeAtomic(join(dir, bin), file);
      }
    }
  } catch {
    // fail-open: resolution simply falls through to the ladder next time
  }
}
