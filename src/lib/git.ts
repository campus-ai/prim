import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

const GIT_TIMEOUT_MS = 1_000;
const MAX_SETTINGS_BYTES = 1024 * 1024;
const GITHUB_OWNER_PATTERN = /^(?![A-Za-z0-9-]*--)[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/u;
const GITHUB_REPOSITORY_PATTERN = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/u;

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
      timeout: GIT_TIMEOUT_MS,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * The main checkout's root when `cwd` is inside a linked worktree, or null in a
 * main checkout, a bare or separated repository, or outside git.
 */
export function mainWorktreeRoot(cwd?: string): string | null {
  try {
    const [gitDir, commonDir] = execFileSync(
      "git",
      ["rev-parse", "--git-dir", "--git-common-dir"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_TIMEOUT_MS,
      },
    )
      .trim()
      .split("\n")
      .map((value) => resolve(cwd ?? process.cwd(), value));
    if (gitDir === undefined || commonDir === undefined || gitDir === commonDir) return null;
    return basename(commonDir) === ".git" ? dirname(commonDir) : null;
  } catch {
    return null;
  }
}

export type RepositoryIdentitySource = "origin" | "declared" | "root_commit";

export type RepositoryContext = {
  /** Canonical local git worktree root. */
  repoRoot: string;
  /** Opaque, clone-stable repository identity. Absent for an unidentifiable repo. */
  repoKey?: string;
  identitySource?: RepositoryIdentitySource;
  /** Validated GitHub owner/name from a GitHub origin, or else the checkout's declaration. */
  repoFullName?: string;
  /** Existing server-issued local repository binding. */
  repoSyncId?: string;
};

function gitValue(cwd: string, args: string[]): string | undefined {
  try {
    const value = execFileSync("git", args, {
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

/** Return the checked-out branch name, or undefined for detached/non-git worktrees. */
export function currentBranch(cwd: string): string | undefined {
  return gitValue(cwd, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
}

/** Validate one `owner/name` path; trailing `.git` and edge slashes are ignored. */
export function parseGithubRepositoryName(path: string): string | null {
  const parts = path
    .replace(/^\/+|\/+$/g, "")
    .replace(/\.git$/i, "")
    .split("/");
  if (
    parts.length !== 2 ||
    !GITHUB_OWNER_PATTERN.test(parts[0] ?? "") ||
    !GITHUB_REPOSITORY_PATTERN.test(parts[1] ?? "")
  ) {
    return null;
  }
  return `${parts[0]}/${parts[1]}`;
}

function githubRepositoryFromRemote(remote: string): string | null {
  if ([...remote].some((char) => char < " " || char === "\u007f")) return null;
  const match =
    /^(?:git@github\.com:([^?#]+)|(?:https|ssh):\/\/(?:[^/@]+@)?github\.com(?::\d+)?\/([^?#]+))$/i.exec(
      remote,
    );
  const path = match?.[1] ?? match?.[2];
  return path ? parseGithubRepositoryName(path) : null;
}

/**
 * Whether origin identifies the repository on its own (a GitHub or other
 * normalizable remote). Exactly when it does not, a declaration applies.
 */
export function originIdentifiesRepository(cwd: string): boolean {
  const remote = gitValue(cwd, ["config", "--get", "remote.origin.url"]);
  return (
    remote !== undefined &&
    Boolean(githubRepositoryFromRemote(remote) || normalizeOriginRemote(remote))
  );
}

/** The GitHub repository origin names, never credentials; null when it names none. */
export function originGithubRepository(cwd: string): string | null {
  const remote = gitValue(cwd, ["config", "--get", "remote.origin.url"]);
  return remote ? githubRepositoryFromRemote(remote) : null;
}

/**
 * Whether git would leave `path` out of a commit because an ignore rule
 * covers it. A file that is already tracked is not ignored, whatever the
 * rules say. False when git cannot tell.
 */
export function isGitIgnored(cwd: string, path: string): boolean {
  try {
    execFileSync("git", ["check-ignore", "--quiet", "--", path], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
      timeout: GIT_TIMEOUT_MS,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * The text of a checkout's own `.claude/settings.json` (the working-tree
 * file, normally committed), or null when there is none prim will read. A
 * real directory and a regular file of settings size only: a symlink could
 * borrow another checkout's declaration, and a FIFO or device would hang the
 * hook reading it.
 */
export function checkoutSettingsText(repoRoot: string): string | null {
  const path = join(repoRoot, ".claude", "settings.json");
  try {
    if (!lstatSync(join(repoRoot, ".claude")).isDirectory()) return null;
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > MAX_SETTINGS_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * One string a checkout declares for itself under `env` in its
 * `.claude/settings.json`. It is read from that file, never from the process
 * environment, so a declaration speaks only for the checkout that carries
 * it, the same for every process that resolves the checkout.
 */
export function checkoutDeclaration(repoRoot: string, name: string): string | null {
  const text = checkoutSettingsText(repoRoot);
  if (text === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  const env =
    typeof parsed === "object" && parsed !== null ? (parsed as { env?: unknown }).env : undefined;
  const value =
    typeof env === "object" && env !== null ? (env as Record<string, unknown>)[name] : undefined;
  return typeof value === "string" ? value : null;
}

/**
 * The GitHub repository a checkout declares for itself as `env.PRIM_REPOSITORY`;
 * `prim claude install --scope project` records it from origin.
 */
export function declaredGithubRepository(repoRoot: string): string | null {
  const value = checkoutDeclaration(repoRoot, "PRIM_REPOSITORY");
  return value === null ? null : parseGithubRepositoryName(value.trim());
}

/**
 * Return a strict GitHub owner/repository name, never credentials. A GitHub
 * origin names it. A declaration applies only when origin cannot identify the
 * repository at all (a Claude Code cloud bundle upload has no origin), so the
 * name and the repository key always come from the same source.
 */
export function githubRepositoryFullName(cwd: string): string | null {
  const remote = gitValue(cwd, ["config", "--get", "remote.origin.url"]);
  if (remote) {
    const fromOrigin = githubRepositoryFromRemote(remote);
    if (fromOrigin || normalizeOriginRemote(remote)) return fromOrigin;
  }
  const root = gitToplevel(cwd);
  return root ? declaredGithubRepository(root) : null;
}

export function canonicalGitRoot(cwd: string): string | null {
  try {
    const top = gitToplevel(cwd);
    return top ? realpathSync.native(top) : null;
  } catch {
    return null;
  }
}

/** A target outside cwd may belong to a sibling worktree, never an unrelated clone. */
export function relatedWorktreeTarget(
  path: string,
  cwd: string,
  origin: RepositoryContext,
): RepositoryContext | null {
  let parent = dirname(resolve(cwd, path));
  while (true) {
    try {
      realpathSync.native(parent);
      break;
    } catch {
      const next = dirname(parent);
      if (next === parent) return null;
      parent = next;
    }
  }
  const target = resolveRepositoryContext(parent);
  if (!target || !target.repoKey || target.repoKey !== origin.repoKey) return null;
  const common = (root: string): string | undefined => {
    const value = gitValue(root, ["rev-parse", "--git-common-dir"]);
    try {
      return value ? realpathSync.native(resolve(root, value)) : undefined;
    } catch {
      return undefined;
    }
  };
  const originCommon = common(origin.repoRoot);
  return originCommon && originCommon === common(target.repoRoot) ? target : null;
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
  const repoFullName = githubRepositoryFullName(repoRoot) ?? undefined;
  const normalizedOrigin = origin ? normalizeOriginRemote(origin) : undefined;
  if (normalizedOrigin) {
    return {
      repoRoot,
      repoKey: opaqueRepoKey("origin", normalizedOrigin),
      identitySource: "origin",
      repoFullName,
    };
  }
  // Without a usable origin, the checkout's declaration (the repoFullName
  // resolved above) keys it exactly as its github.com clone is keyed, so the
  // identity matches developers' clones.
  if (repoFullName) {
    return {
      repoRoot,
      repoKey: opaqueRepoKey("origin", `github.com/${repoFullName}`),
      identitySource: "declared",
      repoFullName,
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
      repoFullName,
    };
  }
  return { repoRoot, repoFullName };
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
function canonicalRepositoryPathScoped(
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

function canonicalRepositoryPathLegacy(
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

export function canonicalRepositoryPath(
  filePath: string,
  context: RepositoryContext,
  baseDir: string,
): CanonicalPathResult;
export function canonicalRepositoryPath(
  filePath: string,
  cwd: string,
  repositoryRoot?: string | null,
): string | null;
export function canonicalRepositoryPath(
  filePath: string,
  contextOrCwd: RepositoryContext | string,
  baseDirOrRoot?: string | null,
): CanonicalPathResult | string | null {
  if (typeof contextOrCwd === "string") {
    return canonicalRepositoryPathLegacy(filePath, contextOrCwd, baseDirOrRoot);
  }
  return canonicalRepositoryPathScoped(
    filePath,
    contextOrCwd,
    baseDirOrRoot ?? contextOrCwd.repoRoot,
  );
}
