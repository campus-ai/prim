import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

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

export type RepositoryIdentitySource = "origin" | "root_commit";

export type RepositoryContext = {
  /** Canonical local git worktree root. */
  repoRoot: string;
  /** Opaque, clone-stable repository identity. Absent for an unidentifiable repo. */
  repoKey?: string;
  identitySource?: RepositoryIdentitySource;
};

function gitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", args, {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return value || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Remove credentials and spelling differences from an origin URL before it is
 * hashed. The normalized value never leaves this process; only its SHA-256
 * digest is put on the wire.
 */
export function normalizeOriginRemote(remote: string): string | undefined {
  const value = remote.trim();
  if (!value) return undefined;

  // SCP-style remotes (`git@github.com:org/repo.git`). The path is deliberately
  // case-preserving; only the DNS hostname is case-insensitive.
  const scp = !value.includes("://")
    ? /^(?:[^@/\s]+@)?(?<host>[^:/\s]+):(?<path>.+)$/.exec(value)?.groups
    : undefined;
  if (scp?.host && scp.path) {
    const path = scp.path.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    return path ? `${scp.host.toLowerCase()}/${path}` : undefined;
  }

  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    const path = url.pathname.replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
    // `host` retains an explicit non-default port and brackets IPv6 literals.
    // Different ports can address different repositories on a self-hosted
    // server, so reducing this to `hostname` would create identity collisions.
    if (url.host && path) return `${url.host.toLowerCase()}/${path}`;
    // file:// and other hostless URLs are machine-specific. Do not pretend
    // they identify the same repository across clones.
    return undefined;
  } catch {
    return undefined;
  }
}

function opaqueRepoKey(source: RepositoryIdentitySource, value: string): string {
  return `repo_v1_${createHash("sha256").update(`${source}\0${value}`).digest("hex")}`;
}

/** Resolve the git root and a credential-free opaque repository identity. */
export function resolveRepositoryContext(cwd: string = process.cwd()): RepositoryContext | null {
  const top = gitToplevel(cwd);
  if (!top) return null;
  let repoRoot: string;
  try {
    repoRoot = realpathSync.native(top);
  } catch {
    repoRoot = resolve(top);
  }

  const origin = gitValue(repoRoot, ["config", "--get", "remote.origin.url"]);
  const normalizedOrigin = origin ? normalizeOriginRemote(origin) : undefined;
  if (normalizedOrigin) {
    return {
      repoRoot,
      repoKey: opaqueRepoKey("origin", normalizedOrigin),
      identitySource: "origin",
    };
  }

  // The current history's root commit is stable across normal clones and
  // worktrees. Do not include unrelated/orphan refs: merely fetching one must
  // not change the identity of the checked-out repository history.
  const roots = gitValue(repoRoot, ["rev-list", "--max-parents=0", "HEAD"])
    ?.split(/\s+/)
    .filter(Boolean)
    .sort();
  if (roots && roots.length > 0) {
    return {
      repoRoot,
      repoKey: opaqueRepoKey("root_commit", roots.join("\n")),
      identitySource: "root_commit",
    };
  }
  return { repoRoot };
}

export type CanonicalPathResult =
  | { ok: true; file: string }
  | { ok: false; reason: "outside_repository" | "invalid_path" };

function nearestExistingAncestor(path: string): { real: string; suffix: string[] } | null {
  const suffix: string[] = [];
  let cursor = path;
  while (true) {
    try {
      // `existsSync` follows symlinks and therefore reports a dangling
      // symlink as absent. `lstatSync` stops the ancestor walk at the link;
      // the realpath below then rejects it instead of treating its name as an
      // ordinary, safely in-repository path.
      lstatSync(cursor);
      break;
    } catch (error) {
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? (error as { code?: unknown }).code
          : undefined;
      if (code !== "ENOENT" && code !== "ENOTDIR") return null;
      const parent = dirname(cursor);
      if (parent === cursor) return null;
      suffix.unshift(cursor.slice(parent.length + (parent.endsWith(sep) ? 0 : 1)));
      cursor = parent;
    }
  }
  try {
    return { real: realpathSync.native(cursor), suffix };
  } catch {
    return null;
  }
}

/**
 * Convert a literal path into the single git-root-relative key used by v2.
 * Existing symlinks (including a symlinked parent of a not-yet-created file)
 * are resolved, so a path that escapes the repository is rejected visibly.
 */
export function canonicalRepositoryPath(
  filePath: string,
  context: RepositoryContext,
  baseDir: string,
): CanonicalPathResult {
  if (!filePath || filePath !== filePath.trim() || filePath.includes("\0")) {
    return { ok: false, reason: "invalid_path" };
  }
  const absolute = resolve(baseDir, filePath);
  const resolved = nearestExistingAncestor(absolute);
  if (!resolved) return { ok: false, reason: "invalid_path" };
  const target = resolve(resolved.real, ...resolved.suffix);
  const rel = relative(context.repoRoot, target);
  if (!rel || rel === ".") return { ok: false, reason: "invalid_path" };
  if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) {
    return { ok: false, reason: "outside_repository" };
  }
  return { ok: true, file: sep === "/" ? rel : rel.split(sep).join("/") };
}
