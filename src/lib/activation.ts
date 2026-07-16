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
import { gitToplevel } from "./git.js";

export const PRIM_ACTIVE_KEY = "prim.active";

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
function repoActiveFlag(cwd: string): "true" | "false" | undefined {
  try {
    const value = execFileSync("git", ["config", "--get", PRIM_ACTIVE_KEY], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
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
  });
}

/**
 * Best-effort activate `cwd` — a project-scope install (git hooks or agent
 * hooks written into this repo) implies the user wants prim here, so it doubles
 * as `prim enable`. Never throws: a non-repo cwd or missing git is non-fatal,
 * the install itself already succeeded.
 */
export function activateRepoBestEffort(cwd: string): void {
  try {
    setRepoActive(cwd, true);
  } catch {
    // Not a git work tree / git unavailable — activation is a convenience here.
  }
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
