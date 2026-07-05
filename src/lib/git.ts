import { execFileSync } from "node:child_process";

/**
 * The repository's top-level working directory for `cwd` (default: process cwd),
 * or null outside a git work tree. One place for `git rev-parse --show-toplevel`
 * so callers stop re-implementing it with divergent error conventions; each
 * wraps this with its own fallback (cwd, throw, or null) as it needs.
 */
export function gitToplevel(cwd?: string): string | null {
  try {
    return execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return null;
  }
}
