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
 * sessions.
 */
import { chmodSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { binFile } from "./bin-path.js";

// Canonical shell-side contract consumed by both live Git hook readers. The
// drift-guard spec evaluates this expression and pins both generated blocks to
// these exact values.
export const GIT_HOOK_CACHE_SHELL_DIR = "${XDG_CACHE_HOME:-$HOME/.cache}/prim/bin";
export const GIT_HOOK_CACHE_TTL_MINUTES = 1440;

const GIT_HOOK_CACHED_BINS = ["prim-post-commit", "prim-post-rewrite"] as const;

/**
 * Absolute cache dir. GIT_HOOK_CACHE_SHELL_DIR must evaluate to this same path;
 * a spec pins both XDG and HOME fallback branches.
 */
export function binCacheDir(): string {
  const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  return join(base, "prim", "bin");
}

// write-then-rename so a concurrent reader never sees a half-written path; a
// per-pid tmp name keeps concurrent SessionStart processes from colliding on
// the same temp file.
function writeAtomic(path: string, content: string): void {
  atomicWriteFile(path, content, { mode: 0o600 });
}

/**
 * Persist the resolved Git hook paths so commit/rewrite capture can skip npx.
 * A no-op under the PRIM_BIN_CACHE=0 kill switch, and never throws — a hook
 * must not break because the cache could not be written.
 */
export function warmBinCache(): void {
  try {
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
    for (const bin of GIT_HOOK_CACHED_BINS) {
      const file = binFile(bin);
      if (file) {
        writeAtomic(join(dir, bin), file);
      }
    }
  } catch {
    // fail-open: the live Git hook falls through to its exact-version fallback
  }
}
