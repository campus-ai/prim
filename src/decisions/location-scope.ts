/**
 * Validate the `--scope-dir` and `--scope-glob` selectors before they are sent.
 *
 * The server does not reject a request over one bad selector: it ignores the
 * whole location scope and answers with a warning, which leaves the Decision
 * governing the entire repository. These predicates mirror the server's, so a
 * selector it would ignore is refused here instead and nothing is sent.
 */

export class LocationScopeInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocationScopeInputError";
  }
}

const MAX_SELECTOR_CHARS = 4096;
// biome-ignore lint/suspicious/noControlCharactersInRegex: selectors must not carry control bytes
const CONTROL_RE = /[\x00-\x1f\x7f]/;
const GLOB_DISALLOWED_RE = /[[\]{}!()\\~$`]/u;

function isRelativeSegment(segment: string): boolean {
  return segment !== "" && segment !== "." && segment !== "..";
}

/** The server's predicate for a `directories` entry. */
export function isCanonicalScopeDirectory(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SELECTOR_CHARS &&
    !value.startsWith("/") &&
    !value.includes("\\") &&
    !CONTROL_RE.test(value) &&
    value.split("/").every(isRelativeSegment)
  );
}

/** The server's predicate for a `globs` entry. */
export function isCanonicalScopeGlob(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_SELECTOR_CHARS &&
    !value.startsWith("/") &&
    !CONTROL_RE.test(value) &&
    value
      .split("/")
      .every((segment) => isRelativeSegment(segment) && !GLOB_DISALLOWED_RE.test(segment))
  );
}

/**
 * Drop one leading `./` and any trailing slashes: spellings of the same
 * directory that shells and tab completion produce. Nothing else is rewritten.
 */
export function normalizeScopeDirectory(value: string): string {
  return value.replace(/^\.\//u, "").replace(/\/+$/u, "");
}

/** The directories to send for `--scope-dir`, or a refusal naming the first bad value. */
export function scopeDirectories(values: readonly string[]): string[] {
  return values.map((value) => {
    const directory = normalizeScopeDirectory(value);
    if (!isCanonicalScopeDirectory(directory)) {
      throw new LocationScopeInputError(
        `--scope-dir ${JSON.stringify(value)} is not a repository-relative directory; use a path such as docs/ga, with no leading "/", no "\\", and no empty, "." or ".." segment`,
      );
    }
    return directory;
  });
}

/** The globs to send for `--scope-glob`, unchanged, or a refusal naming the first bad value. */
export function scopeGlobs(values: readonly string[]): string[] {
  for (const value of values) {
    if (!isCanonicalScopeGlob(value)) {
      throw new LocationScopeInputError(
        `--scope-glob ${JSON.stringify(value)} is not an accepted glob; use a repository-relative pattern such as src/**/*.ts, with no leading "/", no empty, "." or ".." segment, and none of [ ] { } ! ( ) \\ ~ $ \``,
      );
    }
  }
  return [...values];
}
