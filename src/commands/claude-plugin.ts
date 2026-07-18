/**
 * Claude Code skill delivery as a skills-directory plugin.
 *
 * For `--agent claude`, prim installs a skills-directory plugin at
 * `~/.claude/skills/prim/` (user scope) or `<gitRoot>/.claude/skills/prim/`
 * (project scope) instead of injecting a managed block into CLAUDE.md. Claude
 * Code auto-loads a folder with a `.claude-plugin/plugin.json` manifest as
 * `prim@skills-dir` on the next session — no marketplace, no install step. The
 * SKILL.md we write is the same content the file-block path uses, but delivered
 * as a model-invoked skill (pulled into context only when its description
 * triggers) rather than an always-on CLAUDE.md block.
 *
 * Codex/Hermes and every other target keep the rules-file block in skill.ts;
 * this module is reached only from the `opts.agent === "claude"` guards there.
 */

import { createHash } from "node:crypto";
import {
  constants,
  closeSync,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  rmdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { withFileLock } from "../lib/file-lock.js";
import { gitToplevel } from "../lib/git.js";
import { printJson } from "../output.js";
import { atomicWrite, loadSkill } from "./skill.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLUGIN_DESCRIPTION =
  "Primitive decision-graph guidance for the prim CLI — a model-invoked skill installed by prim skill install.";

const MAX_MANIFEST_BYTES = 64 * 1_024;
const MAX_SKILL_BYTES = 1_024 * 1_024;
const REFRESH_LOCK_TIMEOUT_MS = 150;
const REFRESH_LOCK_POLL_MS = 10;

/** The plugin directory for an explicit command scope. User scope is
 * machine-global and cwd-independent; explicit project installs anchor at the
 * git root, with cwd retained as the CLI's documented non-repository fallback. */
function pluginDirFor(cwd: string, scope: "user" | "project"): string {
  const base =
    scope === "user" ? join(homedir(), ".claude") : join(gitToplevel(cwd) ?? cwd, ".claude");
  return join(base, "skills", "prim");
}

/**
 * The plugin directory for (cwd, scope), or null on an unknown scope (already
 * logged). Mirrors resolveTarget's --scope validation. No "--scope user
 * requires --agent" gate — the agent is already claude.
 */
export function resolvePluginDir(cwd: string, scope?: string): string | null {
  if (scope && scope !== "user" && scope !== "project") {
    console.error(`Unknown --scope "${scope}" (expected user or project)`);
    return null;
  }
  return pluginDirFor(cwd, scope === "user" ? "user" : "project");
}

/**
 * The prim package version, resolved by walking up to package.json — the same
 * dual dev/prod resolution loadSkill uses for SKILL.md, so the manifest carries
 * a real version in both `src/commands/` and bundled `dist/`.
 */
function packageVersion(): string {
  let dir = __dirname;
  while (dir !== dirname(dir)) {
    const p = resolve(dir, "package.json");
    if (existsSync(p)) return (JSON.parse(readFileSync(p, "utf-8")) as { version: string }).version;
    dir = dirname(dir);
  }
  return "0.0.0";
}

function pluginManifest(version: string): string {
  const manifest = { name: "prim", description: PLUGIN_DESCRIPTION, version };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function renderClaudePlugin(): { manifest: string; skill: string; version: string } {
  const version = packageVersion();
  return { manifest: pluginManifest(version), skill: loadSkill(), version };
}

/** Remove `dir` only if it exists and is empty — prunes our scaffolding without
 * touching a dir that still holds unrelated user files. */
function removeDirIfEmpty(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** The plugin's two managed files under `dir` — the single statement of the
 * on-disk layout, shared with the spec. */
export function pluginPaths(dir: string): { manifestPath: string; skillPath: string } {
  return {
    manifestPath: join(dir, ".claude-plugin", "plugin.json"),
    skillPath: join(dir, "SKILL.md"),
  };
}

export interface ClaudePluginRefreshResult {
  installed: number;
  refreshed: number;
}

export interface ClaudePluginRefreshOptions {
  /** Project files belong to the repository and are refreshed only after its
   * activation gate passes. User-scope files remain machine-global. */
  includeProject?: boolean;
  /** A git root already resolved by the SessionStart activation gate. */
  projectRoot?: string;
}

type ParsedSemver = { core: [bigint, bigint, bigint]; prerelease: string[] };

function parseSemver(value: unknown): ParsedSemver | undefined {
  if (typeof value !== "string" || value.length > 256) return;
  const match =
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u.exec(
      value,
    );
  if (!match) return;
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/u.test(part) && part.length > 1 && part.startsWith("0"))) {
    return;
  }
  return { core: [BigInt(match[1]), BigInt(match[2]), BigInt(match[3])], prerelease };
}

/** SemVer precedence, or undefined when either input is not valid SemVer. */
export function compareSemver(left: unknown, right: unknown): number | undefined {
  const a = parseSemver(left);
  const b = parseSemver(right);
  if (!a || !b) return;
  for (let i = 0; i < a.core.length; i += 1) {
    if (a.core[i] !== b.core[i]) return a.core[i] < b.core[i] ? -1 : 1;
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0) {
    return a.prerelease.length === b.prerelease.length ? 0 : a.prerelease.length === 0 ? 1 : -1;
  }
  const length = Math.max(a.prerelease.length, b.prerelease.length);
  for (let i = 0; i < length; i += 1) {
    const x = a.prerelease[i];
    const y = b.prerelease[i];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const xNumeric = /^\d+$/u.test(x);
    const yNumeric = /^\d+$/u.test(y);
    if (xNumeric && yNumeric) return BigInt(x) < BigInt(y) ? -1 : 1;
    if (xNumeric !== yNumeric) return xNumeric ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function pathIsInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Auto-refresh never follows managed-file symlinks. Project files must also
 * resolve inside the physical repository, so a committed parent symlink cannot
 * redirect SessionStart writes elsewhere. */
function managedPathsAreSafe(
  paths: { manifestPath: string; skillPath: string },
  projectRoot?: string,
): boolean {
  try {
    const managed = [paths.manifestPath, paths.skillPath];
    if (managed.some((path) => !lstatSync(path).isFile())) return false;
    if (projectRoot === undefined) return true;
    const realRoot = realpathSync(projectRoot);
    return managed.every((path) => pathIsInside(realRoot, realpathSync(path)));
  } catch {
    return false;
  }
}

function readBoundedRegularFile(path: string, maxBytes: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error("unsafe managed file");
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1_024, maxBytes + 1 - total));
      const bytesRead = readSync(fd, chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total > maxBytes) throw new Error("unsafe managed file");
    return Buffer.concat(chunks, total).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

function hasUsablePrimFrontmatter(skill: string): boolean {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u.exec(skill);
  if (!match) return false;
  try {
    const parsed = parseYaml(match[1]) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const frontmatter = parsed as Record<string, unknown>;
    return (
      frontmatter.name === "prim" &&
      typeof frontmatter.description === "string" &&
      frontmatter.description.trim().length > 0 &&
      match[2].trim().length > 0
    );
  } catch {
    return false;
  }
}

function inspectRecognizedInstallation(
  paths: { manifestPath: string; skillPath: string },
  projectRoot?: string,
):
  | {
      manifest: string;
      manifestVersion: unknown;
      skill: string;
      usable: boolean;
    }
  | undefined {
  if (!existsSync(paths.manifestPath) || !existsSync(paths.skillPath)) return;
  if (!managedPathsAreSafe(paths, projectRoot)) return;
  const manifest = readBoundedRegularFile(paths.manifestPath, MAX_MANIFEST_BYTES);
  const parsed = JSON.parse(manifest) as { name?: unknown; version?: unknown };
  if (parsed.name !== "prim") return;
  const skill = readBoundedRegularFile(paths.skillPath, MAX_SKILL_BYTES);
  return {
    manifest,
    manifestVersion: parsed.version,
    skill,
    usable: hasUsablePrimFrontmatter(skill),
  };
}

function refreshLockDir(physicalPluginDir: string): string {
  const cacheRoot = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
  const identity = createHash("sha256").update(physicalPluginDir).digest("hex");
  return join(cacheRoot, "prim", "skill-refresh-locks", `${identity}.lock`);
}

/**
 * Refresh every recognized Claude skills-directory installation without ever
 * creating a new one. Recognition is intentionally strict: both managed files
 * must exist, and the manifest must be valid JSON naming the `prim` plugin.
 * Every scope is fail-soft so a broken user copy cannot strand a healthy
 * project copy (or vice versa) during SessionStart.
 *
 * User-scope freshness is content equality: the running binary owns the local
 * managed files. Project scope is shared, so a strictly newer usable installed
 * version is never downgraded; same-version drift and older copies are repaired.
 * Refresh attempts are serialized per physical install. A usable current skill
 * remains available if convergence fails; an unusable copy is retried at the
 * next SessionStart without gating proactive guidance.
 */
export async function refreshClaudePlugins(
  cwd: string,
  options: ClaudePluginRefreshOptions = {},
): Promise<ClaudePluginRefreshResult> {
  const result: ClaudePluginRefreshResult = { installed: 0, refreshed: 0 };
  const candidates: Array<{ dir: string; projectRoot?: string }> = [];
  if (options.includeProject !== false) {
    const projectRoot = options.projectRoot ?? gitToplevel(cwd);
    if (projectRoot !== null && isAbsolute(projectRoot)) {
      candidates.push({ dir: join(projectRoot, ".claude", "skills", "prim"), projectRoot });
    }
  }
  candidates.push({ dir: pluginDirFor(cwd, "user") });
  const seen = new Set<string>();

  let desired: { manifest: string; skill: string; version: string } | undefined;

  for (const { dir, projectRoot } of candidates) {
    let counted = false;
    const markInstalled = () => {
      if (!counted) {
        result.installed += 1;
        counted = true;
      }
    };

    const refreshCandidate = () => {
      const { manifestPath, skillPath } = pluginPaths(dir);
      const paths = { manifestPath, skillPath };
      try {
        let changed = false;
        const current = inspectRecognizedInstallation(paths, projectRoot);
        if (!current) return;

        desired ??= renderClaudePlugin();
        if (
          projectRoot !== undefined &&
          current.usable &&
          compareSemver(current.manifestVersion, desired.version) === 1
        ) {
          markInstalled();
          return;
        }
        if (current.manifest !== desired.manifest) {
          if (!managedPathsAreSafe(paths, projectRoot)) throw new Error("unsafe managed path");
          atomicWrite(manifestPath, desired.manifest);
          if (!changed) result.refreshed += 1;
          changed = true;
        }
        if (current.skill !== desired.skill) {
          if (!managedPathsAreSafe(paths, projectRoot)) throw new Error("unsafe managed path");
          atomicWrite(skillPath, desired.skill);
          if (!changed) result.refreshed += 1;
          changed = true;
        }
        markInstalled();
      } catch {
        // Reinspect while the per-install lock is still held. A failed writer
        // may have removed or replaced the file that was usable at first read.
        try {
          if (inspectRecognizedInstallation(paths, projectRoot)?.usable) markInstalled();
        } catch {
          // The final pair is not safely usable for this session.
        }
      }
    };

    try {
      const paths = pluginPaths(dir);
      if (!existsSync(paths.manifestPath) || !existsSync(paths.skillPath)) continue;
      const physicalPluginDir = realpathSync(dir);
      if (seen.has(physicalPluginDir)) continue;
      seen.add(physicalPluginDir);
      await withFileLock(refreshLockDir(physicalPluginDir), refreshCandidate, {
        timeoutMs: REFRESH_LOCK_TIMEOUT_MS,
        pollMs: REFRESH_LOCK_POLL_MS,
      });
    } catch {
      // Lock setup/contention is non-fatal at SessionStart. Without the lock,
      // do not inspect or count a pair another process may be replacing.
    }
  }

  return result;
}

export function installClaudePlugin(
  cwd: string,
  opts: { scope?: string; dryRun?: boolean },
): number {
  const dir = resolvePluginDir(cwd, opts.scope);
  if (dir === null) return 1;

  const { manifestPath, skillPath } = pluginPaths(dir);
  const { manifest, skill } = renderClaudePlugin();

  const manifestCurrent = existsSync(manifestPath) ? readFileSync(manifestPath, "utf-8") : null;
  const skillCurrent = existsSync(skillPath) ? readFileSync(skillPath, "utf-8") : null;
  if (manifestCurrent === manifest && skillCurrent === skill) {
    console.log("No changes — prim skill plugin already up to date.");
    return 0;
  }
  if (opts.dryRun) {
    console.log(`Would write plugin to ${dir} (.claude-plugin/plugin.json + SKILL.md)`);
    return 0;
  }

  // One mkdir creates skills/prim/ and skills/prim/.claude-plugin/, so both
  // atomicWrite targets have their parent dir.
  mkdirSync(join(dir, ".claude-plugin"), { recursive: true });
  atomicWrite(manifestPath, manifest);
  atomicWrite(skillPath, skill);

  console.log(`Installed prim skill plugin at ${dir}`);
  console.log("Restart Claude Code or run /reload-plugins to load it.");
  if (opts.scope !== "user") {
    console.log("Project-scope plugins load only when Claude Code launches from this directory.");
  }
  return 0;
}

export function uninstallClaudePlugin(cwd: string, opts: { scope?: string }): number {
  const dir = resolvePluginDir(cwd, opts.scope);
  if (dir === null) return 1;

  const { manifestPath, skillPath } = pluginPaths(dir);
  // Only act on a dir that actually holds OUR plugin — a stray skills/prim a
  // user made by hand (no manifest + no SKILL.md) is left untouched.
  if (!existsSync(manifestPath) && !existsSync(skillPath)) {
    console.log(`prim skill plugin not present at ${dir}`);
    return 0;
  }
  // Remove ONLY the two files we wrote, then prune the now-empty scaffolding —
  // never a recursive delete of the plugin dir, which would take unrelated user
  // files co-located under ~/.claude/skills/prim/ with it.
  rmSync(manifestPath, { force: true });
  rmSync(skillPath, { force: true });
  removeDirIfEmpty(join(dir, ".claude-plugin"));
  removeDirIfEmpty(dir);
  console.log(`Removed prim skill plugin from ${dir}`);
  return 0;
}

export function statusClaudePlugin(cwd: string, opts: { scope?: string; json?: boolean }): number {
  const dir = resolvePluginDir(cwd, opts.scope);
  if (dir === null) return 1;

  const { skillPath } = pluginPaths(dir);
  const installed = existsSync(skillPath);

  if (opts.json) {
    printJson({ installed, target: dir });
    return installed ? 0 : 1;
  }
  if (installed) {
    console.log(`prim skill plugin installed at ${dir}`);
    return 0;
  }
  console.log(`No prim skill plugin at ${dir}`);
  return 1;
}
