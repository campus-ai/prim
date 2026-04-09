/**
 * Extract file path references from spec text and convert them to glob patterns.
 *
 * Used by spec create/update to auto-map file patterns so the pre-commit hook
 * can detect affected specs without manual `prim spec map` calls.
 */

const FALSE_POSITIVE_WORDS = new Set(["N/A", "n/a", "w/o", "i/o", "I/O", "and/or", "either/or"]);

/**
 * Check if a candidate string is a false positive (URL, version, abbreviation, etc.).
 */
function isFalsePositive(s: string): boolean {
  if (FALSE_POSITIVE_WORDS.has(s)) return true;
  // URLs
  if (/^https?:\/\//.test(s) || s.includes("://") || s.startsWith("//")) return true;
  // Absolute paths
  if (s.startsWith("/")) return true;
  // Version-like: HTTP/2, TLS/1.3, node/v20
  if (/^[A-Za-z]+\/[v]?\d/.test(s)) return true;
  // Date-like: 2024/01/15
  if (/^\d{4}\/\d{2}/.test(s)) return true;
  // Package-only: @scope/package (no deeper path segments or file extension)
  if (/^@[\w-]+\/[\w-]+$/.test(s)) return true;
  return false;
}

/**
 * Convert a file path to a directory-level glob pattern.
 * e.g. "src/auth/login.ts" → "src/auth/**"
 */
function toDirectoryGlob(filePath: string): string | undefined {
  const lastSlash = filePath.lastIndexOf("/");
  if (lastSlash <= 0) return undefined;
  return `${filePath.slice(0, lastSlash)}/**`;
}

/**
 * Extract file/directory references from spec text and return glob patterns.
 *
 * Detects:
 * 1. Existing glob patterns (src/**\/*.ts) — kept verbatim
 * 2. Directory references (src/auth/) — converted to src/auth/**
 * 3. File paths (src/auth/login.ts) — converted to src/auth/**
 */
export function extractPatterns(text: string): string[] {
  const patterns = new Set<string>();

  // Match path-like strings: must contain at least one /
  // Boundaries: start of line, whitespace, backtick, quote
  const regex = /(?:^|[\s`"'(])([.\w@-][\w./@*-]*(?:\*[\w./*-]*|\/[\w.*@-]*))/gm;

  for (const match of text.matchAll(regex)) {
    let candidate = match[1];

    // Strip leading ./
    if (candidate.startsWith("./")) {
      candidate = candidate.slice(2);
    }

    // Must contain at least one /
    if (!candidate.includes("/")) continue;

    if (isFalsePositive(candidate)) continue;

    // Glob pattern — keep verbatim
    if (candidate.includes("*")) {
      patterns.add(candidate);
      continue;
    }

    // Directory reference (ends with /)
    if (candidate.endsWith("/")) {
      patterns.add(`${candidate.replace(/\/+$/, "")}/**`);
      continue;
    }

    // File path (has extension) — convert to directory glob
    if (/\.[\w]+$/.test(candidate)) {
      const glob = toDirectoryGlob(candidate);
      if (glob) patterns.add(glob);
      continue;
    }

    // Path without extension (e.g. src/auth) — treat as directory
    patterns.add(`${candidate}/**`);
  }

  return [...patterns].sort();
}
