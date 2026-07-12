import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  constants,
  chmodSync,
  closeSync,
  fchmodSync,
  fsyncSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";

const WORKSPACE_ID_RELATIVE_PATH = join("prim", "workspace-id");
const MAX_ANCESTORS = 64;
const MAX_GIT_FILE_BYTES = 4_096;
const MAX_ID_FILE_BYTES = 128;
const GIT_FALLBACK_TIMEOUT_MS = 250;
const RACE_READ_ATTEMPTS = 5;
const RACE_READ_DELAY_MS = 5;

const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const raceDelay = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

export type WorkspaceIdReady = {
  status: "ready";
  workspaceId: string;
  path: string;
  created: boolean;
};

export type WorkspaceIdInspection =
  | WorkspaceIdReady
  | { status: "missing"; path: string }
  | { status: "not_git" }
  | { status: "corrupt"; path: string; reason: "invalid_content" | "not_file" }
  | {
      status: "unavailable";
      path?: string;
      operation: "resolve" | "read" | "create";
      errorCode?: string;
    };

export type WorkspaceIdResult = Exclude<WorkspaceIdInspection, { status: "missing" }>;

/** True only for the lowercase RFC UUID representation written by this module. */
export function isCanonicalWorkspaceId(value: string): boolean {
  return CANONICAL_UUID.test(value);
}

/**
 * Inspect the current worktree without creating or repairing anything. Doctor
 * and diagnostics use this path so observation never silently rotates identity.
 */
export function inspectWorkspaceId(cwd: string = process.cwd()): WorkspaceIdInspection {
  const resolved = resolveWorkspaceIdPath(cwd);
  if (resolved.status !== "resolved") return resolved;
  return inspectPath(resolved.path);
}

/**
 * Return this Git worktree's stable UUID, creating it once when absent.
 * Failures are data: capture callers can journal a V1 move instead of throwing.
 */
export function getOrCreateWorkspaceId(cwd: string = process.cwd()): WorkspaceIdResult {
  const inspection = inspectWorkspaceId(cwd);
  if (inspection.status !== "missing") return inspection;
  return createWorkspaceId(inspection.path);
}

type ResolvedPath =
  | { status: "resolved"; path: string }
  | { status: "not_git" }
  | {
      status: "unavailable";
      operation: "resolve";
      errorCode?: string;
    };

function resolveWorkspaceIdPath(cwd: string): ResolvedPath {
  // Explicit Git environment overrides can point away from a nearby .git entry.
  // In that unusual case, ask Git so the result remains equivalent to --git-path.
  if (!process.env.GIT_DIR && !process.env.GIT_WORK_TREE) {
    const fromFilesystem = resolveFromFilesystem(cwd);
    if (fromFilesystem) return { status: "resolved", path: fromFilesystem };
  }

  try {
    const output = execFileSync(
      "git",
      ["rev-parse", "--is-inside-work-tree", "--git-path", WORKSPACE_ID_RELATIVE_PATH],
      {
        cwd,
        encoding: "utf8",
        maxBuffer: 4_096,
        stdio: ["ignore", "pipe", "ignore"],
        timeout: GIT_FALLBACK_TIMEOUT_MS,
        windowsHide: true,
      },
    );
    const [insideWorktree, gitPath, ...extra] = output.trim().split(/\r?\n/);
    if (insideWorktree !== "true" || !gitPath || extra.length > 0 || gitPath.includes("\0")) {
      return { status: "not_git" };
    }
    return {
      status: "resolved",
      path: isAbsolute(gitPath) ? resolve(gitPath) : resolve(cwd, gitPath),
    };
  } catch (error) {
    const code = errorCode(error);
    // A missing worktree is the ordinary failure mode. Preserve timeout and
    // permission information for diagnostics without exposing exception text.
    if (code === "ETIMEDOUT" || code === "EACCES" || code === "EPERM") {
      return { status: "unavailable", operation: "resolve", errorCode: code };
    }
    return { status: "not_git" };
  }
}

function resolveFromFilesystem(cwd: string): string | null {
  let current = resolve(cwd);

  for (let depth = 0; depth < MAX_ANCESTORS; depth += 1) {
    const dotGit = join(current, ".git");
    try {
      const stat = lstatSync(dotGit);
      if (stat.isDirectory() && isGitDirectory(dotGit)) {
        return join(dotGit, WORKSPACE_ID_RELATIVE_PATH);
      }
      if (stat.isFile() && stat.size <= MAX_GIT_FILE_BYTES) {
        const contents = readFileSync(dotGit, "utf8");
        const match = /^gitdir: (.+?)(?:\r?\n)?$/.exec(contents);
        if (match?.[1]) {
          const gitDirectory = isAbsolute(match[1])
            ? resolve(match[1])
            : resolve(current, match[1]);
          if (isGitDirectory(gitDirectory)) {
            return join(gitDirectory, WORKSPACE_ID_RELATIVE_PATH);
          }
        }
      }
      // An existing but non-standard .git entry terminates repository discovery.
      // Let the bounded Git fallback interpret it rather than accidentally
      // adopting an enclosing repository's worktree identity.
      return null;
    } catch (error) {
      const code = errorCode(error);
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        // As above, unreadable local metadata must not fall through to an
        // enclosing repository. Git will either resolve it or fail closed.
        return null;
      }
    }

    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return null;
}

function isGitDirectory(path: string): boolean {
  try {
    return statSync(join(path, "HEAD")).isFile();
  } catch {
    return false;
  }
}

function inspectPath(path: string): WorkspaceIdInspection {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { status: "missing", path };
    return { status: "unavailable", path, operation: "read", errorCode: code };
  }

  if (!stat.isFile()) return { status: "corrupt", path, reason: "not_file" };
  if (stat.size > MAX_ID_FILE_BYTES) {
    return { status: "corrupt", path, reason: "invalid_content" };
  }

  try {
    const contents = readFileSync(path, "utf8");
    const workspaceId = contents.endsWith("\n") ? contents.slice(0, -1) : contents;
    if (
      (contents === workspaceId || contents === `${workspaceId}\n`) &&
      isCanonicalWorkspaceId(workspaceId)
    ) {
      return { status: "ready", workspaceId, path, created: false };
    }
    return { status: "corrupt", path, reason: "invalid_content" };
  } catch (error) {
    return {
      status: "unavailable",
      path,
      operation: "read",
      errorCode: errorCode(error),
    };
  }
}

function createWorkspaceId(path: string): WorkspaceIdResult {
  const parent = dirname(path);
  const workspaceId = randomUUID();
  const temporaryPath = join(parent, `.workspace-id-${process.pid}-${randomUUID()}.tmp`);
  let temporaryCreated = false;
  let publishing = false;

  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
    chmodSync(parent, 0o700);

    const fd = openSync(
      temporaryPath,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600,
    );
    temporaryCreated = true;
    try {
      writeFileSync(fd, `${workspaceId}\n`, "utf8");
      fchmodSync(fd, 0o600);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }

    // A hard link publishes a fully-written file and fails rather than replacing
    // a winner from another process. Both names are on the same filesystem.
    publishing = true;
    linkSync(temporaryPath, path);
    return { status: "ready", workspaceId, path, created: true };
  } catch (error) {
    if (publishing && errorCode(error) === "EEXIST") return inspectAfterRace(path);
    return {
      status: "unavailable",
      path,
      operation: "create",
      errorCode: errorCode(error),
    };
  } finally {
    if (temporaryCreated) {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // The identity is already published (or creation already failed); a
        // stale private temp file must not turn successful capture into failure.
      }
    }
  }
}

function inspectAfterRace(path: string): WorkspaceIdResult {
  let result: WorkspaceIdInspection = { status: "missing", path };
  for (let attempt = 0; attempt < RACE_READ_ATTEMPTS; attempt += 1) {
    result = inspectPath(path);
    if (result.status === "ready") return result;
    if (attempt + 1 < RACE_READ_ATTEMPTS) {
      Atomics.wait(raceDelay, 0, 0, RACE_READ_DELAY_MS);
    }
  }

  if (result.status === "missing") {
    return { status: "unavailable", path, operation: "create", errorCode: "EEXIST" };
  }
  return result;
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}
