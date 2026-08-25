/**
 * Resolve and invoke prim bins without depending on a global install.
 *
 * `prim daemon start` must spawn the long-lived
 *     `prim-daemon-server`. binFile() self-locates it by absolute path from the
 *     running code (import.meta.url), so the spawn works whether `daemon start`
 *     ran via `npx` (resolves into the npx cache for the daemon's lifetime) or a
 *     real install — PATH-independent, no second npx resolution.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_NAME = "@primitive.ai/prim";
const ROOT_WALK_LIMIT = 6;
// The npx fallback pins @latest so an un-installed host always resolves the
// newest CLI; the PATH / node_modules branches are taken first when present.
const NPX_FALLBACK = `npx --yes -p ${PKG_NAME}@latest`;
// Branch-0 resolved-path cache. The shell dir expression MUST mirror
// binCacheDir() in bin-cache.ts byte-for-byte (a spec pins the pair). TTL is a
// backstop only — SessionStart (cacheRead:false) refreshes @latest per session.
const BIN_CACHE_DIR_SH = "${XDG_CACHE_HOME:-$HOME/.cache}/prim/bin";
const BIN_CACHE_TTL_MIN_DEFAULT = 1440;

type PackageManifest = { name?: string; version?: string; bin?: Record<string, string> };

let resolvedRoot: { dir: string; version?: string; bin: Record<string, string> } | null | undefined;

/**
 * Walk up from this module's location to the prim package root — the nearest
 * ancestor whose package.json `name` is the prim package. Works from the
 * bundled `dist/` layout, an npx cache, AND the `src/` layout under vitest.
 * Cached after the first resolution.
 */
function locateRoot(): { dir: string; version?: string; bin: Record<string, string> } | null {
  if (resolvedRoot !== undefined) {
    return resolvedRoot;
  }
  let dir = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < ROOT_WALK_LIMIT; depth++) {
    const manifestPath = join(dir, "package.json");
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, "utf-8")) as PackageManifest;
        if (manifest.name === PKG_NAME && manifest.bin) {
          resolvedRoot = { dir, version: manifest.version, bin: manifest.bin };
          return resolvedRoot;
        }
      } catch {
        // unreadable / unparseable manifest — keep walking
      }
    }
    const parent = dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  resolvedRoot = null;
  return resolvedRoot;
}

/** Absolute path to a published bin's entry file, or null if unresolvable. */
export function binFile(bin: string): string | null {
  const root = locateRoot();
  const rel = root?.bin[bin];
  if (!root || !rel) {
    return null;
  }
  return isAbsolute(rel) ? rel : join(root.dir, rel);
}

export function packageVersion(): string | null {
  return locateRoot()?.version ?? null;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

export function pinnedHookCommand(bin: string, args = ""): string {
  const version = packageVersion();
  if (!version) throw new Error("cannot determine Primitive package version");
  const suffix = args ? ` ${args}` : "";
  const fallback = `npx --yes -p ${PKG_NAME}@${version} ${bin}${suffix}`;
  const file = binFile(bin);
  if (!file) return fallback;
  return `if [ -x ${shellQuote(process.execPath)} ] && [ -f ${shellQuote(file)} ]; then ${shellQuote(process.execPath)} ${shellQuote(file)}${suffix}; else ${fallback}; fi`;
}

/**
 * A self-resolving shell command for a settings.json hook: try the bin on PATH,
 * then a local `node_modules/.bin`, then `npx --yes @latest`. Mirrors the
 * git-hook resolver (hooks.ts:hookShim) but — unlike it — adds no
 * `2>/dev/null || true`: a Claude Code / Codex hook's STDOUT (e.g. the gate's
 * permissionDecision) and exit code are load-bearing and must pass through.
 * That holds for the gate and statusline (stdout), post-tool-use (its stderr
 * verdict footer is a deliberate human signal), and session-start (its stdout
 * injects additionalContext under codex) — which is why they stay synchronous;
 *   hookShimCommand("prim-hook")                 // capture
 *   hookShimCommand("prim-hook", "--agent codex")// codex capture
 *   hookShimCommand("prim", "statusline")        // statusline
 *
 * cacheRead (default true) prepends branch-0: if the hooks have cached this
 * bin's resolved entry within TTL, `exec` it directly — turning a per-fire
 * npx@latest resolution into a `cat` + exec (see lib/bin-cache.ts). It marks
 * the exec with PRIM_BIN_CACHE_HIT (so the warmer does not bump mtime and
 * freeze the TTL) and `exec` both preserves the hook's stdout/exit code AND
 * stops fallthrough to the ladder. Any doubt — kill switch (PRIM_BIN_CACHE=0),
 * missing/expired entry, an npx-GC'd target — fails open to the unchanged
 * ladder. Pass cacheRead:false to emit the bare ladder (SessionStart, which
 * must re-resolve @latest each session, and the detached wrapper).
 */
export function hookShimCommand(
  bin: string,
  args = "",
  opts: { cacheRead?: boolean } = {},
): string {
  const invoke = (cmd: string): string => (args ? `${cmd} ${args}` : cmd);
  const ladder =
    `if command -v ${bin} >/dev/null 2>&1; then ${invoke(bin)}; ` +
    `elif [ -f "./node_modules/.bin/${bin}" ]; then ${invoke(`./node_modules/.bin/${bin}`)}; ` +
    `else ${invoke(`${NPX_FALLBACK} ${bin}`)}; fi`;
  if (opts.cacheRead === false) {
    return ladder;
  }
  const execArgs = args ? ` ${args}` : "";
  // One template literal (not a concat) so lint doesn't split hairs over the
  // trailing `fi; ` operand; kept on a single logical line like the ladder.
  const cacheBranch = `d="${BIN_CACHE_DIR_SH}"; if [ "\${PRIM_BIN_CACHE:-1}" != "0" ] && [ -f "$d/${bin}" ] && [ -f "$d/node" ] && [ -n "$(find "$d/${bin}" -mmin "-\${PRIM_BIN_CACHE_TTL_MIN:-${BIN_CACHE_TTL_MIN_DEFAULT}}" 2>/dev/null)" ]; then n=$(cat "$d/node"); p=$(cat "$d/${bin}"); if [ -x "$n" ] && [ -f "$p" ]; then export PRIM_BIN_CACHE_HIT=1; exec "$n" "$p"${execArgs}; fi; fi; `;
  return cacheBranch + ladder;
}

export function detachedHookShimCommand(bin: string, args = ""): string {
  return `payload=$(cat); { trap '' HUP; export npm_config_fetch_retries=2 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=10000 npm_config_fetch_timeout=60000; printf '%s' "$payload" | { ${pinnedHookCommand(bin, args)}; }; } </dev/null >/dev/null 2>&1 &`;
}

/**
 * Does `command` invoke `bin`, in either the legacy bare form ("prim-hook",
 * "prim-hook --agent codex") or the current resolution shim? Matched on the
 * `command -v <bin>` token the shim always carries — the seam that lets a plain
 * re-install recognize and upgrade an older install, and uninstall strip it.
 * The five hook bin names are mutually non-substring, so the token never
 * cross-matches a sibling.
 */
export function commandMatchesBin(command: string | undefined, bin: string): boolean {
  if (!command) {
    return false;
  }
  const c = command.trim();
  // Legacy bare form, with or without trailing args.
  if (c === bin || c.startsWith(`${bin} `)) {
    return true;
  }
  // Resolution shim — keyed on its `command -v <bin> ` probe.
  const exactBin = new RegExp(`(?:^|\\s)${bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s|;|$)`);
  return c.includes(`command -v ${bin} `) || (c.includes(`-p ${PKG_NAME}@`) && exactBin.test(c));
}
