import { execFileSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

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
function gitValue(cwd: string, args: string[]): string | null {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || null;
  } catch {
    return null;
  }
}
export function githubRepositoryFullName(cwd: string): string | null {
  const remote = gitValue(cwd, ["config", "--get", "remote.origin.url"]);
  if (!remote || [...remote].some((char) => char < " " || char === "\u007f")) return null;
  const match =
    /^(?:git@github\.com:([^?#]+)|(?:https|ssh):\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/([^?#]+))$/i.exec(
      remote,
    );
  const path = match?.[1] ?? match?.[2];
  if (!path) return null;
  const parts = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (parts.length !== 2 || parts.some((part) => !part || part !== part.trim())) return null;
  return `${parts[0]}/${parts[1]}`;
}
export function canonicalGitRoot(cwd: string): string | null {
  try {
    const top = gitToplevel(cwd);
    return top ? realpathSync.native(top) : null;
  } catch {
    return null;
  }
}
export function canonicalRepositoryPath(
  filePath: string,
  cwd: string,
  repositoryRoot: string | null = canonicalGitRoot(cwd),
): string | null {
  if (
    !repositoryRoot ||
    !filePath ||
    [...filePath].some((char) => char < " " || char === "\u007f" || "~*?[]{}$`\\".includes(char))
  )
    return null;
  const absolute = resolve(cwd, filePath);
  let target: string;
  try {
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    target = realpathSync.native(absolute);
  } catch (error) {
    if (!(error instanceof Error) || (error as NodeJS.ErrnoException).code !== "ENOENT") {
      return null;
    }
    try {
      const parent = realpathSync.native(dirname(absolute));
      if (!lstatSync(parent).isDirectory()) return null;
      target = resolve(parent, basename(absolute));
    } catch {
      return null;
    }
  }
  const rel = relative(repositoryRoot, target);
  if (!rel || isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return null;
  }
  return sep === "/" ? rel : rel.split(sep).join("/");
}
