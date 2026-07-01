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
 * Personal and per-clone — no files added to the repo tree. The hook shell
 * reads the same flag inline (`git config --get prim.active`), so an inactive
 * repo costs one config read and never spawns node.
 */
import { execFileSync } from "node:child_process";

export const PRIM_ACTIVE_KEY = "prim.active";

/** True iff `prim.active` resolves (local over global) to "true" for `cwd`. */
export function isRepoActive(cwd: string): boolean {
  try {
    return (
      execFileSync("git", ["config", "--get", PRIM_ACTIVE_KEY], {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim() === "true"
    );
  } catch {
    // Unset (exit 1) or not a git repo → inactive, honoring the opt-in default.
    return false;
  }
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
