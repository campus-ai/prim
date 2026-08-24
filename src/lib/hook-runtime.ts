import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { atomicWriteFile } from "./atomic-file.js";
import { STABLE_HOOK_LAUNCHER_NAME, packageRoot, packageVersion } from "./bin-path.js";
import { withFileLockSync } from "./file-lock.js";
import { type PrimConfigDirectoryOptions, primConfigDirectory } from "./paths.js";
import { compareSemver } from "./semver.js";

const HOOK_RUNTIME_SCHEMA_VERSION = 1;
const DIRECTORY_MODE = 0o700;
const DATA_FILE_MODE = 0o600;
const LAUNCHER_MODE = 0o700;
const RELEASE_PREFIX = "release-";
const RELEASE_NAME_RE = /^release-[0-9a-f]{64}$/u;
const MAX_MANIFEST_BYTES = 64 * 1024;
const MAX_RELEASES = 8;
const MAX_RELEASE_DELETIONS_PER_STAGE = 8;
const RETAIN_PREDECESSORS = 2;
const RELEASE_GRACE_MS = 10 * 60 * 1000;

export const HOOK_RUNTIME_ENTRIES = {
  // SessionStart self-healing resolves this exact CLI entry to run
  // `daemon ensure`; it must travel with the immutable hook release.
  prim: "dist/index.js",
  "prim-hook": "dist/hooks/prim-hook.js",
  "prim-pre-commit": "dist/hooks/pre-commit.js",
  "prim-post-commit": "dist/hooks/post-commit.js",
  "prim-post-rewrite": "dist/hooks/post-rewrite.js",
  "prim-pre-tool-use": "dist/hooks/pre-tool-use.js",
  "prim-post-tool-use": "dist/hooks/post-tool-use.js",
  "prim-session-start": "dist/hooks/session-start.js",
  "prim-session-end": "dist/hooks/session-end.js",
  "prim-daemon-server": "dist/daemon/server.js",
  "prim-statusline": "dist/statusline-main.js",
} as const;

type HookRuntimeBin = keyof typeof HOOK_RUNTIME_ENTRIES;

const SOURCE_ENTRIES: Record<HookRuntimeBin, string> = Object.fromEntries(
  Object.entries(HOOK_RUNTIME_ENTRIES).map(([bin, target]) => [
    bin,
    target.replace(/^dist\//u, ""),
  ]),
) as Record<HookRuntimeBin, string>;

type HookRuntimeManifest = {
  schemaVersion: typeof HOOK_RUNTIME_SCHEMA_VERSION;
  version: string;
  nodePath: string;
  files: Record<HookRuntimeBin, string>;
};

export type HookRuntimePaths = {
  configDir: string;
  launcher: string;
  runtimeDir: string;
  releasesDir: string;
  current: string;
  selectionLock: string;
};

export type StageHookRuntimeOptions = PrimConfigDirectoryOptions & {
  sourceDir?: string;
  nodePath?: string;
  version?: string;
};

export type StageHookRuntimeResult = {
  changed: boolean;
  releaseDir: string;
  manifest: HookRuntimeManifest;
  paths: HookRuntimePaths;
};

export type RemoveHookRuntimeResult = {
  changed: boolean;
  paths: HookRuntimePaths;
};

export function hookRuntimePaths(options: PrimConfigDirectoryOptions = {}): HookRuntimePaths {
  // The persisted POSIX launcher can only resolve its default from HOME. Pass
  // that exact environment value into the shared canonical path resolver so
  // staging cannot silently fall back to a different OS-account directory.
  const env = options.env ?? process.env;
  const configDir = primConfigDirectory({
    ...options,
    env,
    homeDir: options.homeDir ?? env.HOME ?? "",
  });
  const runtimeDir = join(configDir, "hook-runtime");
  return {
    configDir,
    launcher: join(configDir, STABLE_HOOK_LAUNCHER_NAME),
    runtimeDir,
    releasesDir: join(runtimeDir, "releases"),
    current: join(runtimeDir, "current"),
    selectionLock: join(runtimeDir, "selection.lock"),
  };
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function exactManifest(manifest: HookRuntimeManifest): string {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function releaseId(manifest: HookRuntimeManifest): string {
  return createHash("sha256").update(exactManifest(manifest)).digest("hex");
}

function runtimePackageJson(manifest: HookRuntimeManifest): string {
  return `${JSON.stringify(
    {
      name: "@primitive.ai/prim",
      version: manifest.version,
      type: "module",
      bin: HOOK_RUNTIME_ENTRIES,
    },
    null,
    2,
  )}\n`;
}

function validateRelease(releaseDir: string, manifest: HookRuntimeManifest): boolean {
  try {
    if (readFileSync(join(releaseDir, "manifest.json"), "utf8") !== exactManifest(manifest)) {
      return false;
    }
    if (readFileSync(join(releaseDir, "package.json"), "utf8") !== runtimePackageJson(manifest)) {
      return false;
    }
    if (readFileSync(join(releaseDir, "node"), "utf8") !== `${manifest.nodePath}\n`) {
      return false;
    }
    for (const [bin, relativePath] of Object.entries(HOOK_RUNTIME_ENTRIES) as [
      HookRuntimeBin,
      string,
    ][]) {
      const target = join(releaseDir, relativePath);
      if (!statSync(target).isFile() || sha256(target) !== manifest.files[bin]) return false;
    }
    return true;
  } catch {
    return false;
  }
}

function readReleaseManifest(releaseDir: string, releaseName: string): HookRuntimeManifest | null {
  try {
    const manifestPath = join(releaseDir, "manifest.json");
    const manifestStat = statSync(manifestPath);
    if (!manifestStat.isFile() || manifestStat.size > MAX_MANIFEST_BYTES) return null;
    const raw = readFileSync(manifestPath, "utf8");
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (!exactKeys(parsed, ["schemaVersion", "version", "nodePath", "files"])) return null;
    const candidate = parsed as Partial<HookRuntimeManifest>;
    if (
      candidate.schemaVersion !== HOOK_RUNTIME_SCHEMA_VERSION ||
      typeof candidate.version !== "string" ||
      compareSemver(candidate.version, candidate.version) !== 0 ||
      typeof candidate.nodePath !== "string" ||
      !isAbsolute(candidate.nodePath) ||
      /[\r\n]/u.test(candidate.nodePath) ||
      !candidate.files ||
      typeof candidate.files !== "object" ||
      Array.isArray(candidate.files) ||
      !exactKeys(candidate.files, Object.keys(HOOK_RUNTIME_ENTRIES)) ||
      Object.values(candidate.files).some(
        (digest) => typeof digest !== "string" || !/^[0-9a-f]{64}$/u.test(digest),
      )
    ) {
      return null;
    }
    const manifest = candidate as HookRuntimeManifest;
    if (
      raw !== exactManifest(manifest) ||
      releaseName !== `${RELEASE_PREFIX}${releaseId(manifest)}` ||
      !validateRelease(releaseDir, manifest)
    ) {
      return null;
    }
    return manifest;
  } catch {
    return null;
  }
}

type SelectedRelease = {
  name: string;
  dir: string;
  manifest: HookRuntimeManifest;
};

function readSelectedRelease(paths: HookRuntimePaths): SelectedRelease | null {
  let raw: string;
  try {
    raw = readFileSync(paths.current, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const name = raw.endsWith("\n") ? raw.slice(0, -1) : "";
  if (`${name}\n` !== raw || !RELEASE_NAME_RE.test(name)) {
    throw new Error("cannot stage hook runtime: selected release is malformed");
  }
  const dir = join(paths.releasesDir, name);
  const manifest = readReleaseManifest(dir, name);
  if (!manifest) {
    throw new Error("cannot stage hook runtime: immutable release is corrupt");
  }
  return { name, dir, manifest };
}

type ReleaseEntry = { name: string; dir: string; mtimeMs: number };

function releaseEntries(paths: HookRuntimePaths): ReleaseEntry[] {
  return readdirSync(paths.releasesDir, { withFileTypes: true }).flatMap((entry) => {
    if (!entry.isDirectory() || !RELEASE_NAME_RE.test(entry.name)) return [];
    const dir = join(paths.releasesDir, entry.name);
    try {
      return [{ name: entry.name, dir, mtimeMs: statSync(dir).mtimeMs }];
    } catch {
      return [];
    }
  });
}

function pruneReleases(
  paths: HookRuntimePaths,
  protectedNames: ReadonlySet<string>,
  reserveSlots: number,
  now: number,
): void {
  // The launcher snapshots `current` without taking the installer lock. Keep
  // the selected release, its immediate predecessors, and every recent
  // release so an already-running hook can finish. Admission fails instead of
  // deleting protected bytes when the owner-only store reaches its hard cap.
  const entries = releaseEntries(paths).sort(
    (left, right) => right.mtimeMs - left.mtimeMs || left.name.localeCompare(right.name),
  );
  const protectedWithPredecessors = new Set(protectedNames);
  for (const entry of entries) {
    if (protectedWithPredecessors.size >= protectedNames.size + RETAIN_PREDECESSORS) break;
    if (!protectedWithPredecessors.has(entry.name)) protectedWithPredecessors.add(entry.name);
  }
  const candidates = entries
    .filter(
      (entry) =>
        !protectedWithPredecessors.has(entry.name) && now - entry.mtimeMs >= RELEASE_GRACE_MS,
    )
    .sort((left, right) => left.mtimeMs - right.mtimeMs || left.name.localeCompare(right.name));
  let remaining = entries.length;
  let deleted = 0;
  for (const entry of candidates) {
    if (remaining + reserveSlots <= MAX_RELEASES || deleted >= MAX_RELEASE_DELETIONS_PER_STAGE) {
      break;
    }
    rmSync(entry.dir, { recursive: true, force: true });
    remaining -= 1;
    deleted += 1;
  }
  if (remaining + reserveSlots > MAX_RELEASES) {
    throw new Error(
      "cannot stage hook runtime: release retention is full while recent runtimes are protected",
    );
  }
}

function sourceManifest(sourceDir: string, version: string, nodePath: string): HookRuntimeManifest {
  const files = {} as Record<HookRuntimeBin, string>;
  for (const [bin, relativePath] of Object.entries(SOURCE_ENTRIES) as [HookRuntimeBin, string][]) {
    const source = join(sourceDir, relativePath);
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`cannot stage hook runtime: missing self-contained ${bin} bundle`);
    }
    files[bin] = sha256(source);
  }
  return { schemaVersion: HOOK_RUNTIME_SCHEMA_VERSION, version, nodePath, files };
}

/**
 * Static launcher bytes. It uses shell builtins only, snapshots one immutable
 * release name from the atomic selector, validates the closed bin vocabulary,
 * and execs the exact Node path recorded with that release.
 */
export const STABLE_HOOK_LAUNCHER_CONTENT = `#!/bin/sh
set -eu
case "$0" in */*) prim_launcher_dir=\${0%/*} ;; *) exit 78 ;; esac
IFS= read -r prim_release_name < "$prim_launcher_dir/hook-runtime/current" || exit 69
case "$prim_release_name" in ${RELEASE_PREFIX}*) ;; *) exit 69 ;; esac
prim_release_id=\${prim_release_name#${RELEASE_PREFIX}}
case "$prim_release_id" in *[!0-9a-f]*|"") exit 69 ;; esac
[ "\${#prim_release_id}" -eq 64 ] || exit 69
prim_release="$prim_launcher_dir/hook-runtime/releases/$prim_release_name"
case "\${1-}" in
${Object.entries(HOOK_RUNTIME_ENTRIES)
  .map(([bin, entry]) => `  ${bin}) prim_entry="$prim_release/${entry}" ;;`)
  .join("\n")}
  *) exit 64 ;;
esac
shift
IFS= read -r prim_node < "$prim_release/node" || exit 69
case "$prim_node" in /*) ;; *) exit 69 ;; esac
[ -x "$prim_node" ] && [ -f "$prim_entry" ] || exit 69
exec "$prim_node" "$prim_entry" "$@"
`;

function writeRelease(
  sourceDir: string,
  releaseDir: string,
  manifest: HookRuntimeManifest,
  releasesDir: string,
): void {
  const stagingDir = mkdtempSync(join(releasesDir, ".stage-"));
  chmodSync(stagingDir, DIRECTORY_MODE);
  try {
    for (const [bin, targetRelative] of Object.entries(HOOK_RUNTIME_ENTRIES) as [
      HookRuntimeBin,
      string,
    ][]) {
      const source = join(sourceDir, SOURCE_ENTRIES[bin]);
      const target = join(stagingDir, targetRelative);
      mkdirSync(dirname(target), { recursive: true, mode: DIRECTORY_MODE });
      chmodSync(dirname(target), DIRECTORY_MODE);
      copyFileSync(source, target);
      chmodSync(target, DATA_FILE_MODE);
      if (sha256(target) !== manifest.files[bin]) {
        throw new Error(`cannot stage hook runtime: ${bin} changed while it was copied`);
      }
    }
    writeFileSync(join(stagingDir, "node"), `${manifest.nodePath}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: DATA_FILE_MODE,
    });
    writeFileSync(join(stagingDir, "package.json"), runtimePackageJson(manifest), {
      encoding: "utf8",
      flag: "wx",
      mode: DATA_FILE_MODE,
    });
    writeFileSync(join(stagingDir, "manifest.json"), exactManifest(manifest), {
      encoding: "utf8",
      flag: "wx",
      mode: DATA_FILE_MODE,
    });
    try {
      renameSync(stagingDir, releaseDir);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if ((code !== "EEXIST" && code !== "ENOTEMPTY") || !validateRelease(releaseDir, manifest)) {
        throw error;
      }
    }
  } finally {
    rmSync(stagingDir, { recursive: true, force: true });
  }
}

/** Prepare and atomically select a durable, self-contained exact hook runtime. */
export function stageHookRuntime(options: StageHookRuntimeOptions = {}): StageHookRuntimeResult {
  const root = packageRoot();
  const sourceDir = options.sourceDir ?? (root ? join(root, "dist", "hook-runtime") : null);
  const version = options.version ?? packageVersion();
  const nodePath = resolve(options.nodePath ?? process.execPath);
  if (
    !sourceDir ||
    !version ||
    compareSemver(version, version) !== 0 ||
    !isAbsolute(nodePath) ||
    /[\r\n]/u.test(nodePath)
  ) {
    throw new Error("cannot stage hook runtime: package identity is unavailable");
  }

  const manifest = sourceManifest(sourceDir, version, nodePath);
  const paths = hookRuntimePaths(options);
  const releaseName = `${RELEASE_PREFIX}${releaseId(manifest)}`;
  const releaseDir = join(paths.releasesDir, releaseName);
  mkdirSync(paths.releasesDir, { recursive: true, mode: DIRECTORY_MODE });
  chmodSync(paths.configDir, DIRECTORY_MODE);
  chmodSync(paths.runtimeDir, DIRECTORY_MODE);
  chmodSync(paths.releasesDir, DIRECTORY_MODE);

  return withFileLockSync(paths.selectionLock, () => {
    const now = Date.now();
    const selected = readSelectedRelease(paths);
    if (selected) utimesSync(selected.dir, now / 1000, now / 1000);
    const precedence = selected ? compareSemver(selected.manifest.version, manifest.version) : -1;
    if (precedence === undefined) {
      throw new Error("cannot stage hook runtime: selected release version is malformed");
    }
    const selectRequested = !selected || precedence < 0;
    const requestedExists = existsSync(releaseDir);
    const protectedBefore = new Set<string>(selected ? [selected.name] : []);
    if (selectRequested && requestedExists) protectedBefore.add(releaseName);
    pruneReleases(paths, protectedBefore, selectRequested && !requestedExists ? 1 : 0, now);

    if (selectRequested && !validateRelease(releaseDir, manifest)) {
      if (requestedExists) {
        throw new Error("cannot stage hook runtime: immutable release is corrupt");
      }
      writeRelease(sourceDir, releaseDir, manifest, paths.releasesDir);
    }

    const finalRelease = selectRequested
      ? { name: releaseName, dir: releaseDir, manifest }
      : (selected as SelectedRelease);
    const launcherCurrent = (() => {
      try {
        return readFileSync(paths.launcher, "utf8") === STABLE_HOOK_LAUNCHER_CONTENT;
      } catch {
        return false;
      }
    })();
    const selectorCurrent = selected?.name === finalRelease.name;
    if (!launcherCurrent) {
      atomicWriteFile(paths.launcher, STABLE_HOOK_LAUNCHER_CONTENT, {
        ensureParent: true,
        mode: LAUNCHER_MODE,
      });
    }
    if (!selectorCurrent) {
      atomicWriteFile(paths.current, `${finalRelease.name}\n`, {
        ensureParent: true,
        mode: DATA_FILE_MODE,
      });
    }
    utimesSync(finalRelease.dir, now / 1000, now / 1000);
    pruneReleases(
      paths,
      new Set([finalRelease.name, ...(selected ? [selected.name] : [])]),
      0,
      now,
    );

    return {
      changed: !launcherCurrent || !selectorCurrent,
      releaseDir: finalRelease.dir,
      manifest: finalRelease.manifest,
      paths,
    };
  });
}

export function assertOwnedHookRuntime(paths: HookRuntimePaths): void {
  if (existsSync(paths.launcher)) {
    const launcher = lstatSync(paths.launcher);
    if (
      !launcher.isFile() ||
      readFileSync(paths.launcher, "utf8") !== STABLE_HOOK_LAUNCHER_CONTENT
    ) {
      throw new Error(`refusing to remove unrecognized hook launcher at ${paths.launcher}`);
    }
  }
  if (!existsSync(paths.runtimeDir)) return;
  if (!lstatSync(paths.runtimeDir).isDirectory()) {
    throw new Error(`refusing to remove non-directory hook runtime at ${paths.runtimeDir}`);
  }

  const allowed = new Set(["current", "releases", "selection.lock"]);
  const unexpected = readdirSync(paths.runtimeDir).filter((entry) => !allowed.has(entry));
  if (unexpected.length > 0) {
    throw new Error(
      `refusing to remove hook runtime with unrecognized entries: ${unexpected.sort().join(", ")}`,
    );
  }

  const currentExists = existsSync(paths.current);
  const releasesExist = existsSync(paths.releasesDir);
  if (currentExists) {
    if (!lstatSync(paths.current).isFile() || !releasesExist || !readSelectedRelease(paths)) {
      throw new Error(`refusing to remove malformed hook runtime selection at ${paths.current}`);
    }
  }
  if (!releasesExist) return;
  if (!lstatSync(paths.releasesDir).isDirectory()) {
    throw new Error(`refusing to remove non-directory hook releases at ${paths.releasesDir}`);
  }
  for (const entry of readdirSync(paths.releasesDir, { withFileTypes: true })) {
    const releaseDir = join(paths.releasesDir, entry.name);
    if (
      !entry.isDirectory() ||
      !RELEASE_NAME_RE.test(entry.name) ||
      !readReleaseManifest(releaseDir, entry.name)
    ) {
      throw new Error(`refusing to remove unrecognized hook release ${releaseDir}`);
    }
  }
}

/**
 * Remove only a fully recognized immutable hook runtime.
 *
 * The selection lock serializes this contraction against a concurrent stage.
 * Unknown launchers, releases, or co-located files abort before deletion.
 */
export function removeHookRuntime(
  options: PrimConfigDirectoryOptions = {},
): RemoveHookRuntimeResult {
  const paths = hookRuntimePaths(options);
  const hadLauncher = existsSync(paths.launcher);
  const hadRuntime = existsSync(paths.runtimeDir);
  if (!hadLauncher && !hadRuntime) return { changed: false, paths };

  // Reject obvious foreign ownership before taking a lock inside the runtime.
  assertOwnedHookRuntime(paths);
  if (!hadRuntime) {
    rmSync(paths.launcher, { force: true });
    return { changed: hadLauncher, paths };
  }

  withFileLockSync(paths.selectionLock, () => {
    assertOwnedHookRuntime(paths);
    if (existsSync(paths.launcher)) rmSync(paths.launcher, { force: true });
    const quarantined = `${paths.runtimeDir}.uninstall-${String(process.pid)}-${randomBytes(8).toString("hex")}`;
    renameSync(paths.runtimeDir, quarantined);
    rmSync(quarantined, { recursive: true, force: true });
  });
  return { changed: true, paths };
}
