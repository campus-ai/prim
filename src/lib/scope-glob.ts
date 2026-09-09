/**
 * Shared location-scope glob grammar.
 *
 * Patterns are repository-relative slash-separated segments. `**` spans zero
 * or more segments; `*` and `?` stay within one segment. Keep this matcher
 * RegExp-free so its behavior stays aligned with the server's bounded walker.
 */

const DISALLOWED_PATTERN_CHARACTERS = new Set([
  "[",
  "]",
  "{",
  "}",
  "!",
  "(",
  ")",
  "\\",
  "~",
  "$",
  "`",
]);
export const MAX_SCOPE_GLOB_CHARS = 4_096;

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function splitRepositoryPath(value: string): string[] | undefined {
  if (
    value.length === 0 ||
    value.length > MAX_SCOPE_GLOB_CHARS ||
    value.startsWith("/") ||
    value.includes("\\") ||
    hasControlCharacter(value)
  ) {
    return;
  }
  const segments = value.split("/");
  return segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")
    ? undefined
    : segments;
}

/** True when `value` is a supported location-scope glob pattern. */
export function isScopeGlobPattern(value: string): boolean {
  const segments = splitRepositoryPath(value);
  return (
    segments !== undefined &&
    !segments.some((segment) =>
      Array.from(segment).some((character) => DISALLOWED_PATTERN_CHARACTERS.has(character)),
    )
  );
}

/** True when `value` can be used as a literal directory prefix (`*` is literal here). */
export function isScopeDirectoryPrefix(value: string): boolean {
  return splitRepositoryPath(value) !== undefined;
}

function segmentMatches(pattern: string, value: string): boolean {
  let patternIndex = 0;
  let valueIndex = 0;
  let starIndex = -1;
  let retryValueIndex = 0;

  while (valueIndex < value.length) {
    const patternCharacter = pattern[patternIndex];
    if (patternCharacter === "?" || patternCharacter === value[valueIndex]) {
      patternIndex += 1;
      valueIndex += 1;
      continue;
    }
    if (patternCharacter === "*") {
      starIndex = patternIndex;
      patternIndex += 1;
      retryValueIndex = valueIndex;
      continue;
    }
    if (starIndex < 0) return false;
    patternIndex = starIndex + 1;
    retryValueIndex += 1;
    valueIndex = retryValueIndex;
  }

  while (pattern[patternIndex] === "*") patternIndex += 1;
  return patternIndex === pattern.length;
}

/** Match one validated repository-relative path against one scope glob. */
export function matchesScopeGlob(pattern: string, path: string): boolean {
  if (!isScopeGlobPattern(pattern)) return false;
  const patternSegments = splitRepositoryPath(pattern);
  const pathSegments = splitRepositoryPath(path);
  if (patternSegments === undefined || pathSegments === undefined) return false;

  const memo = new Map<string, boolean>();
  const matchesFrom = (patternIndex: number, pathIndex: number): boolean => {
    const key = `${String(patternIndex)}:${String(pathIndex)}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;

    let matches: boolean;
    const segment = patternSegments[patternIndex];
    if (segment === undefined) {
      matches = pathIndex === pathSegments.length;
    } else if (segment === "**") {
      matches =
        matchesFrom(patternIndex + 1, pathIndex) ||
        (pathIndex < pathSegments.length && matchesFrom(patternIndex, pathIndex + 1));
    } else {
      matches =
        pathIndex < pathSegments.length &&
        segmentMatches(segment, pathSegments[pathIndex] ?? "") &&
        matchesFrom(patternIndex + 1, pathIndex + 1);
    }
    memo.set(key, matches);
    return matches;
  };

  return matchesFrom(0, 0);
}
