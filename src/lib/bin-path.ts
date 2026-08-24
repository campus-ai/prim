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

function shellWord(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/u.test(value) ? value : shellQuote(value);
}

export type PinnedNpxOptions = {
  preferOnline?: boolean;
};

/**
 * Build the one npx argv used for an uninstalled Primitive runtime.
 *
 * The package is always the exact version of the code constructing the
 * command. `--ignore-scripts` prevents package lifecycle scripts from running
 * on these unattended hook/daemon paths. Callers that need a registry
 * revalidation may opt into npm's bounded `--prefer-online` behavior without
 * changing the package-selection rule.
 */
export function pinnedNpxArgs(
  bin: string,
  args: readonly string[] = [],
  options: PinnedNpxOptions = {},
): string[] {
  const version = packageVersion();
  if (!version) throw new Error("cannot determine Primitive package version");
  return [
    "--yes",
    "--ignore-scripts",
    ...(options.preferOnline ? ["--prefer-online"] : []),
    "-p",
    `${PKG_NAME}@${version}`,
    bin,
    ...args,
  ];
}

/** Shell rendering of pinnedNpxArgs for generated POSIX hook blocks. */
export function pinnedNpxCommand(
  bin: string,
  args: readonly string[] = [],
  options: PinnedNpxOptions = {},
): string {
  return ["npx", ...pinnedNpxArgs(bin, args, options)].map(shellWord).join(" ");
}

export function pinnedHookCommand(bin: string, args = ""): string {
  const suffix = args ? ` ${args}` : "";
  const fallback = `${pinnedNpxCommand(bin)}${suffix}`;
  const file = binFile(bin);
  if (!file) return fallback;
  return `if [ -x ${shellQuote(process.execPath)} ] && [ -f ${shellQuote(file)} ]; then ${shellQuote(process.execPath)} ${shellQuote(file)}${suffix}; else ${fallback}; fi`;
}

export function detachedHookShimCommand(bin: string, args = ""): string {
  return `payload=$(cat); { trap '' HUP; export npm_config_fetch_retries=2 npm_config_fetch_retry_mintimeout=10000 npm_config_fetch_retry_maxtimeout=10000 npm_config_fetch_timeout=60000; printf '%s' "$payload" | { ${pinnedHookCommand(bin, args)}; }; } </dev/null >/dev/null 2>&1 &`;
}

/**
 * Does `command` invoke `bin`, in a legacy bare/ladder form or the current
 * exact-version pinned command? Recognizing the historical `command -v` token
 * lets reinstall/uninstall migrate already-written settings without retaining
 * the dead ladder generator in product code.
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
