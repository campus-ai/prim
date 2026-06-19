/**
 * Resolve and invoke prim bins without depending on a global install.
 *
 * Two consumers, two needs:
 *
 *   - The daemon: `prim daemon start` must spawn the long-lived
 *     `prim-daemon-server`. binFile() self-locates it by absolute path from the
 *     running code (import.meta.url), so the spawn works whether `daemon start`
 *     ran via `npx` (resolves into the npx cache for the daemon's lifetime) or a
 *     real install — PATH-independent, no second npx resolution.
 *
 *   - The session hooks: `prim claude|codex install` writes a per-event command
 *     into settings.json. There is no global install to point at, so it writes a
 *     resolution SHIM — PATH → local node_modules → `npx --yes @latest` — the
 *     same ladder the git hooks already use (hooks.ts:hookShim). It resolves
 *     with zero package management and always reaches `@latest` on the npx path.
 *
 * commandMatchesBin() recognizes a written command — legacy bare name OR the
 * current shim — so install/uninstall can identify, upgrade, and strip prim's
 * own entries across both forms.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_NAME = "@primitive.ai/prim";
const ROOT_WALK_LIMIT = 6;
// The npx fallback pins @latest so an un-installed host always resolves the
// newest CLI; the PATH / node_modules branches are taken first when present.
const NPX_FALLBACK = `npx --yes -p ${PKG_NAME}@latest`;

type PackageManifest = { name?: string; bin?: Record<string, string> };

let resolvedRoot: { dir: string; bin: Record<string, string> } | null | undefined;

/**
 * Walk up from this module's location to the prim package root — the nearest
 * ancestor whose package.json `name` is the prim package. Works from the
 * bundled `dist/` layout, an npx cache, AND the `src/` layout under vitest.
 * Cached after the first resolution.
 */
function locateRoot(): { dir: string; bin: Record<string, string> } | null {
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
          resolvedRoot = { dir, bin: manifest.bin };
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

/**
 * A self-resolving shell command for a settings.json hook: try the bin on PATH,
 * then a local `node_modules/.bin`, then `npx --yes @latest`. Mirrors the
 * git-hook resolver (hooks.ts:hookShim) but — unlike it — adds no
 * `2>/dev/null || true`: a Claude Code / Codex hook's STDOUT (e.g. the gate's
 * permissionDecision) and exit code are load-bearing and must pass through.
 *   hookShimCommand("prim-hook")                 // capture
 *   hookShimCommand("prim-hook", "--agent codex")// codex capture
 *   hookShimCommand("prim", "statusline")        // statusline
 */
export function hookShimCommand(bin: string, args = ""): string {
  const invoke = (cmd: string): string => (args ? `${cmd} ${args}` : cmd);
  return (
    `if command -v ${bin} >/dev/null 2>&1; then ${invoke(bin)}; ` +
    `elif [ -f "./node_modules/.bin/${bin}" ]; then ${invoke(`./node_modules/.bin/${bin}`)}; ` +
    `else ${invoke(`${NPX_FALLBACK} ${bin}`)}; fi`
  );
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
  return c.includes(`command -v ${bin} `);
}
