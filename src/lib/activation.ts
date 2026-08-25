/**
 * Repo activation — the opt-in gate for prim's user-scope (global) git hooks.
 *
 * A global `core.hooksPath` makes prim's hooks *fire* in every repo, but they
 * only *act* where prim is activated. The signal is a git config flag,
 * `prim.active`, read merged so repo-local overrides global:
 *
 *   - unset            → inactive everywhere (opt-in default)
 *   - `prim enable`    → `git config --local prim.active true`  (this repo)
 *   - `prim disable`   → `git config --local prim.active false` (mute this repo)
 *   - global opt-out   → `git config --global prim.active true` (every repo)
 *
 * Personal and per-clone — no files added to the repo tree. The global git-hook
 * shell reads the flag inline (`git config --get prim.active`) BEFORE spawning
 * node, so an inactive repo costs one config read and never spawns node. The
 * agent content hooks are already node, so they check in-process and
 * short-circuit before doing any work.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { gitToplevel, githubRepositoryFullName } from "./git.js";

export const PRIM_ACTIVE_KEY = "prim.active";
export const PRIM_REPO_SYNC_ID_KEY = "prim.repoSyncId";
export const PRIM_REPO_SYNC_REPOSITORY_KEY = "prim.repoSyncRepository";
export const PRIM_REPO_BINDING_STATE_KEY = "prim.repoBindingState";
const GIT_TIMEOUT_MS = 1_000;
const REPO_SYNC_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

export type LocalRepositoryBindingState = "connected" | "unbound" | "invalid";

// Project-scope agent config files, relative to the REPO ROOT (where a
// project-scope install writes them). Never the user-scope files under $HOME —
// see hasProjectPrimInstall.
const PROJECT_INSTALL_FILES = [".claude/settings.json", ".codex/hooks.json"];

// prim's actual hook bin names — matched EXACTLY so unrelated config text that
// merely contains the substring "prim-" cannot back-fill activation.
const PRIM_HOOK_BINS = ["prim-hook", "prim-pre-tool-use", "prim-post-tool-use"];

/**
 * The raw `prim.active` value (local over global): "true", "false", or
 * undefined when unset. Distinguishing "false" from unset lets `prim disable`
 * be authoritative while an unset flag can still self-heal (see below).
 */
export function repoActiveFlag(cwd: string): "true" | "false" | undefined {
  try {
    const value = execFileSync("git", ["config", "--get", PRIM_ACTIVE_KEY], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    if (value === "true") return "true";
    if (value === "false") return "false";
    return undefined;
  } catch {
    // Unset (exit 1) or not a git repo.
    return undefined;
  }
}

/** True iff `prim.active` resolves (local over global) to "true" for `cwd`. */
export function isRepoActive(cwd: string): boolean {
  return repoActiveFlag(cwd) === "true";
}

/** Set the repo-local `prim.active` flag. Throws outside a git work tree. */
export function setRepoActive(cwd: string, active: boolean): void {
  execFileSync("git", ["config", "--local", PRIM_ACTIVE_KEY, active ? "true" : "false"], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
}

export function isValidRepoSyncId(value: unknown): value is string {
  return typeof value === "string" && REPO_SYNC_ID_RE.test(value);
}

function localGitConfigValue(cwd: string, key: string): string | undefined {
  try {
    const value = execFileSync("git", ["config", "--local", "--get", key], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Read the server-issued repository binding already stored in local Git
 * config, but only when the saved repository name matches the checkout's
 * current GitHub origin. This is only an attribution hint; the server remains
 * authoritative.
 */
export function repoSyncId(cwd: string): string | undefined {
  const value = localGitConfigValue(cwd, PRIM_REPO_SYNC_ID_KEY);
  if (!isValidRepoSyncId(value)) return undefined;
  const repositoryFullName = localGitConfigValue(cwd, PRIM_REPO_SYNC_REPOSITORY_KEY);
  return repositoryFullName === githubRepositoryFullName(cwd) ? value : undefined;
}

export function setRepoSyncId(cwd: string, value: string, repositoryFullName: string): void {
  if (!isValidRepoSyncId(value)) {
    throw new Error("invalid repository binding returned by server");
  }
  execFileSync("git", ["config", "--local", PRIM_REPO_SYNC_ID_KEY, value], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
  execFileSync("git", ["config", "--local", PRIM_REPO_SYNC_REPOSITORY_KEY, repositoryFullName], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
}

export function setRepositoryBindingState(cwd: string, state: LocalRepositoryBindingState): void {
  if (state !== "connected" && state !== "unbound" && state !== "invalid") {
    throw new Error("invalid repository binding state");
  }
  execFileSync("git", ["config", "--local", PRIM_REPO_BINDING_STATE_KEY, state], {
    cwd,
    stdio: ["ignore", "ignore", "pipe"],
    timeout: GIT_TIMEOUT_MS,
  });
}

/**
 * Read the checkout's last observed repository-binding state.
 *
 * This is diagnostics only: the cached repoSyncId remains an attribution hint
 * and the server re-authorizes it on every use. A legacy id without its saved
 * repository name is withheld until the next successful bind; a missing or
 * malformed id is surfaced immediately.
 */
export function repositoryBindingState(cwd: string): LocalRepositoryBindingState | undefined {
  const rawId = localGitConfigValue(cwd, PRIM_REPO_SYNC_ID_KEY);
  const marker = localGitConfigValue(cwd, PRIM_REPO_BINDING_STATE_KEY);

  if (rawId !== undefined && !isValidRepoSyncId(rawId)) return "invalid";
  if (marker === "unbound" || marker === "invalid") return marker;
  if (marker === "connected") return repoSyncId(cwd) ? "connected" : "invalid";
  if (marker !== undefined) return "invalid";
  return rawId === undefined ? "unbound" : repoSyncId(cwd) ? undefined : "unbound";
}

function unsetLocalGitConfigValue(cwd: string, key: string): void {
  try {
    execFileSync("git", ["config", "--local", "--unset-all", key], {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
      timeout: GIT_TIMEOUT_MS,
    });
  } catch (error) {
    if (typeof error === "object" && error !== null && "status" in error && error.status === 5) {
      return;
    }
    throw error;
  }
}

/**
 * Explicitly remove the checkout's cached server binding.
 *
 * Automatic bind retries never call this: repository-unavailable responses
 * retain the last server-issued id and only mark the diagnostic state unbound.
 */
export function clearRepoSyncId(cwd: string): void {
  unsetLocalGitConfigValue(cwd, PRIM_REPO_SYNC_ID_KEY);
  unsetLocalGitConfigValue(cwd, PRIM_REPO_SYNC_REPOSITORY_KEY);
  setRepositoryBindingState(cwd, "unbound");
}

/**
 * Self-heal for pre-existing project-scope installs. A repo whose project agent
 * config already registers a prim hook wanted prim BEFORE this version's flag
 * existed; treat it as implicitly active so an upgrade doesn't silently stop
 * capture until the user re-runs `prim enable`.
 *
 * Bounded to the git top-level: a project-scope install writes
 * `<repoRoot>/.claude/settings.json` (never an ancestor), so we check the repo
 * root ONLY. A walk to the filesystem root would reach the machine-global
 * `~/.claude/settings.json` (which a user-scope install populates) and wrongly
 * mark EVERY repo under $HOME active — the very opt-in this gate protects.
 */
export function hasProjectPrimInstall(cwd: string): boolean {
  const root = gitToplevel(cwd);
  // null → not a repo. root === homedir() → a dotfiles-as-repo whose
  // <root>/.claude/settings.json IS the machine-global user-scope file; treating
  // it as a project install would re-open the every-repo-under-$HOME hole.
  if (root === null || root === homedir()) return false;
  for (const rel of PROJECT_INSTALL_FILES) {
    const path = join(root, rel);
    if (existsSync(path)) {
      try {
        const content = readFileSync(path, "utf-8");
        if (PRIM_HOOK_BINS.some((bin) => content.includes(bin))) return true;
      } catch {
        // Unreadable config — treat as absent.
      }
    }
  }
  return false;
}

/**
 * The gate the AGENT content hooks (capture, conflict gate, ingest) use:
 *   - "true"    → active
 *   - "false"   → inactive — `prim disable` is authoritative and is NOT
 *                 overridden by the back-fill, so a user can always mute a repo
 *   - unset     → back-fill: active iff a pre-existing project install is found
 * Checked only on the unset fallback, so an active/disabled repo pays just the
 * flag read.
 */
export function isRepoActiveForCapture(cwd: string): boolean {
  const flag = repoActiveFlag(cwd);
  if (flag === "true") return true;
  if (flag === "false") return false;
  return hasProjectPrimInstall(cwd);
}

/** Human-readable decision-ingestion state for the capture gate at `cwd`. */
export function decisionIngestionStatus(cwd: string): "enabled" | "disabled" {
  return isRepoActiveForCapture(cwd) ? "enabled" : "disabled";
}
