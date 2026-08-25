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
import { compareSemver } from "./semver.js";

const PKG_NAME = "@primitive.ai/prim";
const ROOT_WALK_LIMIT = 6;
export const STABLE_HOOK_LAUNCHER_NAME = "prim-hook-launcher-v1";

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

/** Package root containing the currently executing Primitive runtime. */
export function packageRoot(): string | null {
  return locateRoot()?.dir ?? null;
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

const STABLE_HOOK_ARGUMENTS_RE = /^[-A-Za-z0-9_ ]*$/u;
const STABLE_HOOK_BIN_RE = /^[A-Za-z0-9][A-Za-z0-9-]*$/u;

/**
 * Render the one machine-, config-root-, and package-version-independent hook
 * command stored in agent configuration. The inline POSIX resolver mirrors
 * `primConfigDirectory`: only absolute PRIM_CONFIG_DIR/XDG_CONFIG_HOME values
 * are honored, with an absolute HOME fallback. `/bin/sh` is explicit because
 * Hermes invokes configured commands with shell=false.
 *
 * The command itself never selects code. It enters the owner-only launcher,
 * whose atomically selected immutable release pins the exact Node runtime and
 * self-contained package bytes prepared by the installer.
 */
export function stableHookCommand(bin: string, args = ""): string {
  if (!STABLE_HOOK_BIN_RE.test(bin) || !STABLE_HOOK_ARGUMENTS_RE.test(args)) {
    throw new Error("invalid stable hook command");
  }
  const resolver = [
    // #242 and earlier identify managed commands by this package marker. Keep
    // it as inert data during the rolling window so an older uninstall or
    // reinstall can remove the stable entry without invoking npm or PATH.
    `prim_legacy_reader='-p ${PKG_NAME}@stable prim-shim.sh ${bin} '; `,
    'prim_absolute() { case "$1" in /*) ;; *) return 1 ;; esac; ' +
      'case "$1" in [[:space:]]*|*[[:space:]]|*//*|*/./*|*/../*|*/.|*/..|?*/) return 1 ;; esac; }; ',
    'prim_config=${PRIM_CONFIG_DIR:-}; if ! prim_absolute "$prim_config"; then ' +
      'prim_config=${XDG_CONFIG_HOME:-}; if prim_absolute "$prim_config"; then ',
    'case "$prim_config" in /) prim_config=/prim ;; *) prim_config="$prim_config/prim" ;; esac; ',
    'else prim_home=${HOME:-}; prim_absolute "$prim_home" || exit 78; ' +
      'case "$prim_home" in /) prim_config=/.config/prim ;; *) prim_config="$prim_home/.config/prim" ;; esac; ',
    "fi; fi; ",
    `case "$prim_config" in /) prim_launcher=/${STABLE_HOOK_LAUNCHER_NAME} ;; ` +
      `*) prim_launcher="$prim_config/${STABLE_HOOK_LAUNCHER_NAME}" ;; esac; `,
    'exec "$prim_launcher" "$@"',
  ].join("");
  const suffix = args ? ` ${args}` : "";
  return `/bin/sh -c ${shellQuote(resolver)} ${STABLE_HOOK_LAUNCHER_NAME} ${bin}${suffix}`;
}

export function detachedHookShimCommand(bin: string, args = ""): string {
  return `payload=$(cat); { trap '' HUP; printf '%s' "$payload" | { ${stableHookCommand(bin, args)}; }; } </dev/null >/dev/null 2>&1 &`;
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
  return (
    c.includes(`command -v ${bin} `) ||
    (c.includes(`-p ${PKG_NAME}@`) && exactBin.test(c)) ||
    (c.includes(STABLE_HOOK_LAUNCHER_NAME) && exactBin.test(c))
  );
}

/** Runtime selection made by a recognized agent-hook command. */
export type HookCommandResolution =
  | Readonly<{ kind: "stable_launcher" }>
  | Readonly<{ kind: "exact_npx_fallback"; version: string }>
  | Readonly<{ kind: "legacy_path" }>;

function exactPinnedNpxVersion(command: string, bin: string): string | undefined {
  // Recognize only the generated npx grammar. In particular, do not mistake a
  // package selection followed by an arbitrary shell program for Prim's bin.
  // Doctor never executes this fallback; this classification is only enough to
  // describe the persisted registration accurately.
  const escapedBin = bin.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const shellQuoted = "'(?:[^']|'\"'\"')*'";
  const safeArgs = "(?: [A-Za-z0-9_@%+=:,./-]+)*";
  const direct = new RegExp(
    `^npx --yes --ignore-scripts -p @primitive\\.ai/prim@(?<version>[0-9A-Za-z.+-]+) ${escapedBin}${safeArgs}$`,
    "u",
  ).exec(command);
  const wrapped = new RegExp(
    `^if \\[ -x (?<node>${shellQuoted}) \\] && \\[ -f (?<entry>${shellQuoted}) \\]; then \\k<node> \\k<entry>(?<args>${safeArgs}); else npx --yes --ignore-scripts -p @primitive\\.ai/prim@(?<version>[0-9A-Za-z.+-]+) ${escapedBin}\\k<args>; fi$`,
    "u",
  ).exec(command);
  const version = direct?.groups?.version ?? wrapped?.groups?.version;
  return version && compareSemver(version, version) !== undefined ? version : undefined;
}

/**
 * Classify a registered command without executing it. Current launchers require
 * the selected immutable runtime; exact npx fallbacks are retained for
 * migration diagnostics but remain fail-closed because doctor will not run
 * persisted commands.
 */
export function hookCommandResolution(
  command: string | undefined,
  bin: string,
): HookCommandResolution | undefined {
  const trimmed = command?.trim();
  if (!trimmed || !commandMatchesBin(trimmed, bin)) return undefined;
  if (trimmed.includes(STABLE_HOOK_LAUNCHER_NAME)) return { kind: "stable_launcher" };
  const version = exactPinnedNpxVersion(trimmed, bin);
  return version ? { kind: "exact_npx_fallback", version } : { kind: "legacy_path" };
}

/** Classify every Primitive command in an agent configuration. */
export function hookCommandResolutions(
  commands: Iterable<string | undefined>,
  bins: readonly string[],
): HookCommandResolution[] {
  const resolutions: HookCommandResolution[] = [];
  for (const command of commands) {
    for (const bin of bins) {
      const resolution = hookCommandResolution(command, bin);
      if (resolution) resolutions.push(resolution);
    }
  }
  return resolutions;
}
