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

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { gitToplevel } from "../lib/git.js";
import { printJson } from "../output.js";
import { atomicWrite, loadSkill } from "./skill.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

const PLUGIN_DESCRIPTION =
  "Primitive decision-graph guidance for the prim CLI — a model-invoked skill installed by prim skill install.";

/**
 * The plugin directory for (cwd, scope), or null on an unknown scope (already
 * logged). Mirrors resolveTarget's --scope validation. User scope is
 * machine-global and cwd-independent; project scope anchors at the git root (so
 * a committed `.claude/` lives at the repo top), falling back to cwd outside a
 * repo. No "--scope user requires --agent" gate — the agent is already claude.
 */
export function resolvePluginDir(cwd: string, scope?: string): string | null {
  if (scope && scope !== "user" && scope !== "project") {
    console.error(`Unknown --scope "${scope}" (expected user or project)`);
    return null;
  }
  const base =
    scope === "user" ? join(homedir(), ".claude") : join(gitToplevel(cwd) ?? cwd, ".claude");
  return join(base, "skills", "prim");
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

function pluginManifest(): string {
  const manifest = { name: "prim", description: PLUGIN_DESCRIPTION, version: packageVersion() };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function renderClaudePlugin(): { manifest: string; skill: string } {
  return { manifest: pluginManifest(), skill: loadSkill() };
}

/** Remove `dir` only if it exists and is empty — prunes our scaffolding without
 * touching a dir that still holds unrelated user files. */
function removeDirIfEmpty(dir: string): void {
  if (existsSync(dir) && readdirSync(dir).length === 0) rmdirSync(dir);
}

/** The plugin's two managed files under `dir`. */
function pluginPaths(dir: string): { manifestPath: string; skillPath: string } {
  return {
    manifestPath: join(dir, ".claude-plugin", "plugin.json"),
    skillPath: join(dir, "SKILL.md"),
  };
}

export interface ClaudePluginRefreshResult {
  installed: number;
  refreshed: number;
}

type RefreshClaudePluginsOptions = {
  writeFile?: typeof atomicWrite;
};

/**
 * Refresh every recognized Claude skills-directory installation without ever
 * creating a new one. Recognition is intentionally strict: both managed files
 * must exist, and the manifest must be valid JSON naming the `prim` plugin.
 * Every scope is fail-soft so a broken user copy cannot strand a healthy
 * project copy (or vice versa) during SessionStart.
 *
 * Freshness is content equality, not version ordering: the running binary owns
 * the managed files, so an older prim deliberately rewrites newer files to its
 * own content. `refreshed` counts scopes where at least one managed file was
 * rewritten — a partial write still counts, and the next session retries.
 */
export function refreshClaudePlugins(
  cwd: string,
  options: RefreshClaudePluginsOptions = {},
): ClaudePluginRefreshResult {
  const result: ClaudePluginRefreshResult = { installed: 0, refreshed: 0 };
  const dirs = new Set(
    [resolvePluginDir(cwd, "user"), resolvePluginDir(cwd, "project")].filter(
      (dir): dir is string => dir !== null,
    ),
  );

  let desired: { manifest: string; skill: string } | undefined;
  const writeFile = options.writeFile ?? atomicWrite;

  for (const dir of dirs) {
    try {
      const { manifestPath, skillPath } = pluginPaths(dir);
      if (!existsSync(manifestPath) || !existsSync(skillPath)) continue;

      const manifestCurrent = readFileSync(manifestPath, "utf-8");
      const parsed = JSON.parse(manifestCurrent) as { name?: unknown };
      if (parsed.name !== "prim") continue;
      const skillCurrent = readFileSync(skillPath, "utf-8");
      result.installed += 1;

      desired ??= renderClaudePlugin();
      let changed = false;
      if (manifestCurrent !== desired.manifest) {
        try {
          writeFile(manifestPath, desired.manifest);
          changed = true;
        } catch {
          // This scope remains fail-soft; still attempt its other managed file.
        }
      }
      if (skillCurrent !== desired.skill) {
        try {
          writeFile(skillPath, desired.skill);
          changed = true;
        } catch {
          // Continue to the other scope.
        }
      }
      if (changed) result.refreshed += 1;
    } catch {
      // Missing permissions, malformed JSON, and transient reads are all
      // non-fatal at SessionStart. Never repair an unrecognized installation.
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
