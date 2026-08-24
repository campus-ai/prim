/**
 * `bin-cache` coverage — the SessionStart writer for live Git hook readers.
 *
 * Runs against the `src/` layout (like bin-path.spec): binFile() resolves the
 * real `dist/` entries from the repo's own bin map, so the cached paths are the
 * genuine ones the shim would exec.
 */
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  GIT_HOOK_CACHE_SHELL_DIR,
  GIT_HOOK_CACHE_TTL_MINUTES,
  binCacheDir,
  warmBinCache,
} from "./bin-cache.js";
import { binFile } from "./bin-path.js";
import { postCommitHookBlock, postRewriteHookBlock } from "./post-commit-hook.js";

const ENV_KEYS = ["XDG_CACHE_HOME", "HOME", "PRIM_BIN_CACHE"] as const;

function snapshotEnv(): Record<string, string | undefined> {
  const saved: Record<string, string | undefined> = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
  }
  return saved;
}

function restoreEnv(saved: Record<string, string | undefined>): void {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) {
      delete process.env[k];
    } else {
      process.env[k] = saved[k];
    }
  }
}

// Evaluate the canonical live-reader expression in a real shell.
function shellCacheDir(env: NodeJS.ProcessEnv): string {
  return spawnSync("sh", ["-c", `printf %s "${GIT_HOOK_CACHE_SHELL_DIR}"`], {
    env,
    encoding: "utf-8",
  }).stdout;
}

describe("binCacheDir", () => {
  it("honors XDG_CACHE_HOME", () => {
    const saved = snapshotEnv();
    try {
      process.env.XDG_CACHE_HOME = "/x/y/z";
      expect(binCacheDir()).toBe("/x/y/z/prim/bin");
    } finally {
      restoreEnv(saved);
    }
  });

  it("mirrors the shell dir expression the shim embeds — drift guard", () => {
    const saved = snapshotEnv();
    try {
      // XDG branch.
      process.env.XDG_CACHE_HOME = "/x/y/z";
      expect(binCacheDir()).toBe(shellCacheDir(process.env));
      // $HOME/.cache fallback branch.
      // biome-ignore lint/performance/noDelete: env teardown requires actual removal
      delete process.env.XDG_CACHE_HOME;
      process.env.HOME = "/home/tester";
      expect(binCacheDir()).toBe("/home/tester/.cache/prim/bin");
      expect(binCacheDir()).toBe(shellCacheDir(process.env));
      // Empty-string branch: shell `${VAR:-default}` and Node's `||` must both
      // treat "" as unset and fall back — would diverge if the impl used `??`.
      process.env.XDG_CACHE_HOME = "";
      expect(binCacheDir()).toBe("/home/tester/.cache/prim/bin");
      expect(binCacheDir()).toBe(shellCacheDir(process.env));
    } finally {
      restoreEnv(saved);
    }
  });

  it("keeps both live Git hook readers coupled to the canonical dir and TTL", () => {
    for (const block of [postCommitHookBlock(), postRewriteHookBlock()]) {
      expect(block).toContain(`prim_cache_dir="${GIT_HOOK_CACHE_SHELL_DIR}"`);
      expect(block).toContain(`-mmin "-\${PRIM_BIN_CACHE_TTL_MIN:-${GIT_HOOK_CACHE_TTL_MINUTES}}"`);
    }
  });
});

describe("warmBinCache", () => {
  let saved: Record<string, string | undefined>;
  let dir: string;

  beforeEach(() => {
    saved = snapshotEnv();
    // biome-ignore lint/performance/noDelete: env teardown requires actual removal
    delete process.env.PRIM_BIN_CACHE;
    dir = mkdtempSync(join(tmpdir(), "prim-warm-"));
    process.env.XDG_CACHE_HOME = dir;
  });

  afterEach(() => {
    restoreEnv(saved);
    rmSync(dir, { recursive: true, force: true });
  });

  it("writes only the node runtime and live Git hook entries", () => {
    warmBinCache();
    const cacheDir = join(dir, "prim", "bin");
    expect(readFileSync(join(cacheDir, "node"), "utf-8")).toBe(process.execPath);
    for (const bin of ["prim-post-commit", "prim-post-rewrite"]) {
      expect(readFileSync(join(cacheDir, bin), "utf-8")).toBe(binFile(bin));
    }
    for (const obsolete of ["prim", "prim-hook", "prim-pre-tool-use", "prim-post-tool-use"]) {
      expect(existsSync(join(cacheDir, obsolete))).toBe(false);
    }
  });

  it("tightens the cache dir to 0o700 even if a lax-umask run left it 0o755", () => {
    // The shim execs paths read from this dir with only -x/-f guards, so it must
    // be owner-only. mkdir's mode is ignored on a pre-existing dir — the explicit
    // chmod is the load-bearing part, so seed a lax dir and prove it gets tightened.
    const cacheDir = join(dir, "prim", "bin");
    mkdirSync(cacheDir, { recursive: true });
    chmodSync(cacheDir, 0o755);
    warmBinCache();
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
  });

  it("is a no-op under the PRIM_BIN_CACHE=0 kill switch", () => {
    process.env.PRIM_BIN_CACHE = "0";
    warmBinCache();
    expect(existsSync(join(dir, "prim", "bin", "node"))).toBe(false);
  });

  it("fails open (never throws) when the cache dir cannot be created", () => {
    // Point XDG at a regular file so mkdir -p hits ENOTDIR on its parent.
    const asFile = join(dir, "not-a-dir");
    writeFileSync(asFile, "x");
    process.env.XDG_CACHE_HOME = asFile;
    expect(() => warmBinCache()).not.toThrow();
  });
});
