/**
 * Resolved-path cache warmed by SessionStart and consumed by the portable Git
 * post-commit/post-rewrite blocks.
 *
 * Without it, every hook fire on an un-installed host re-resolves the CLI
 * through the exact-version `npx --ignore-scripts` fallback: a full npm
 * process + registry round-trip after each commit/rewrite. This records each
 * hook bin's resolved absolute entry (and the node runtime that resolved it)
 * so the Git hooks can `exec node <entry>` directly.
 *
 * Freshness model: SessionStart rewrites the cache from the exact package that
 * executed it. The TTL is only a backstop for long-lived / SessionStart-less
 * sessions. A cache-hit process must not warm it again (that would bump mtime
 * and freeze the TTL), hence the PRIM_BIN_CACHE_HIT guard retained for older
 * shim callers.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { binFile } from "./bin-path.js";

// Keep the historical cache inventory during the compatibility horizon. The
// live Git blocks consume post-commit/post-rewrite; older installed shims may
// still consume the other entries. Any warm pass writes them all.
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
