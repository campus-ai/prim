/**
 * Build the location scope for `decisions create` and `decisions rescope`, and
 * refuse what the server would ignore.
 *
 * The server does not reject a request over a bad location scope: it ignores
 * the whole scope and answers with a warning, which leaves the Decision
 * governing the entire repository. Every rule here mirrors a server rule, so a
 * scope it would ignore is refused before anything is sent.
 */

import {
  MAX_SCOPE_GLOB_CHARS,
  isScopeDirectoryPrefix,
  isScopeGlobPattern,
} from "../lib/scope-glob.js";

export class LocationScopeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocationScopeInputError";
  }
}

export type LocationScopeOptions = {
  scopeRepo?: boolean;
  scopeDir?: string[];
  scopeGlob?: string[];
  scopeBranch?: string[];
};

export type LocationScopeSelectors = {
  repository?: true;
  directories?: string[];
  globs?: string[];
  branches?: string[];
};

/** Most repository, directory and glob selectors one Decision carries, counted without repeats. */
export const MAX_LOCATION_SCOPE_SELECTORS = 25;
/** Most branch patterns one Decision carries, counted without repeats. */
export const MAX_LOCATION_SCOPE_BRANCHES = 25;
export const MAX_BRANCH_PATTERN_CHARS = 255;
const MAX_SHOWN_VALUE_CHARS = 80;

/** Quote a rejected value for a message, cut short so a huge argument stays one modest line. */
function shown(value: string): string {
  return JSON.stringify(
    value.length <= MAX_SHOWN_VALUE_CHARS ? value : `${value.slice(0, MAX_SHOWN_VALUE_CHARS - 1)}…`,
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/** The server's predicate for a `branches` entry. */
export function isScopeBranchPattern(value: string): boolean {
  return (
    value.length > 0 && value.length <= MAX_BRANCH_PATTERN_CHARS && !hasControlCharacter(value)
  );
}

/**
 * Drop one leading `./` and any trailing slashes: spellings of the same
 * directory that shells and tab completion produce. Nothing else is rewritten.
 * The scan is linear, so a long run of slashes costs no more than its length.
 */
export function normalizeScopeDirectory(value: string): string {
  const start = value.startsWith("./") ? 2 : 0;
  let end = value.length;
  while (end > start && value.charCodeAt(end - 1) === 0x2f) end -= 1;
  return value.slice(start, end);
}

/** The directories to send for `--scope-dir`, or a refusal naming the first bad value. */
export function scopeDirectories(values: readonly string[]): string[] {
  return values.map((value) => {
    const directory = normalizeScopeDirectory(value);
    if (directory === "." || (directory === "" && value.startsWith("./"))) {
      throw new LocationScopeInputError(
        `--scope-dir ${shown(value)} names the repository root; use --scope-repo to govern the whole repository`,
      );
    }
    if (!isScopeDirectoryPrefix(directory)) {
      throw new LocationScopeInputError(
        `--scope-dir ${shown(value)} is not a repository-relative directory; use a path such as docs/ga: no leading "/", no "\\", no control character, no empty, "." or ".." segment, at most ${MAX_SCOPE_GLOB_CHARS} characters`,
      );
    }
    return directory;
  });
}

/** The globs to send for `--scope-glob`, unchanged, or a refusal naming the first bad value. */
export function scopeGlobs(values: readonly string[]): string[] {
  for (const value of values) {
    if (!isScopeGlobPattern(value)) {
      throw new LocationScopeInputError(
        `--scope-glob ${shown(value)} is not an accepted glob; use a repository-relative pattern such as src/**/*.ts: no leading "/", no control character, no empty, "." or ".." segment, none of [ ] { } ! ( ) \\ ~ $ \`, at most ${MAX_SCOPE_GLOB_CHARS} characters`,
      );
    }
  }
  return [...values];
}

/** The patterns to send for `--scope-branch`, unchanged, or a refusal naming the first bad value. */
export function scopeBranches(values: readonly string[]): string[] {
  for (const value of values) {
    if (!isScopeBranchPattern(value)) {
      throw new LocationScopeInputError(
        `--scope-branch ${shown(value)} is not an accepted branch pattern; use a name or pattern such as main or release/*: not empty, no control character, at most ${MAX_BRANCH_PATTERN_CHARS} characters`,
      );
    }
  }
  return [...values];
}

/**
 * The wire location scope for the given flags, or undefined when none was
 * given. Throws LocationScopeInputError for a value or a count the server
 * would answer by ignoring the whole scope. The server counts each list
 * without repeats, so repeats do not count here either.
 */
export function locationScopeFromOptions(
  options: LocationScopeOptions,
): LocationScopeSelectors | undefined {
  const directories = scopeDirectories(options.scopeDir ?? []);
  const globs = scopeGlobs(options.scopeGlob ?? []);
  const branches = scopeBranches(options.scopeBranch ?? []);
  const selectorCount =
    (options.scopeRepo ? 1 : 0) + new Set(directories).size + new Set(globs).size;
  if (selectorCount > MAX_LOCATION_SCOPE_SELECTORS) {
    throw new LocationScopeInputError(
      `--scope-repo, --scope-dir and --scope-glob name ${selectorCount} distinct selectors; a Decision allows at most ${MAX_LOCATION_SCOPE_SELECTORS}`,
    );
  }
  const branchCount = new Set(branches).size;
  if (branchCount > MAX_LOCATION_SCOPE_BRANCHES) {
    throw new LocationScopeInputError(
      `--scope-branch names ${branchCount} distinct branch patterns; a Decision allows at most ${MAX_LOCATION_SCOPE_BRANCHES}`,
    );
  }
  const location: LocationScopeSelectors = {
    ...(options.scopeRepo ? { repository: true } : {}),
    ...(directories.length > 0 ? { directories } : {}),
    ...(globs.length > 0 ? { globs } : {}),
    ...(branches.length > 0 ? { branches } : {}),
  };
  return Object.keys(location).length === 0 ? undefined : location;
}
