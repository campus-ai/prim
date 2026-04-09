import type { CliClient } from "../client.js";
import { extractPatterns } from "./extract-patterns.js";

/**
 * Auto-map file patterns to a spec after create/update.
 *
 * Extracts file references from spec text and POSTs them to the /map endpoint.
 * Failure is non-fatal — emits a warning so the primary operation still succeeds.
 */
export async function autoMapPatterns(
  client: CliClient,
  contextId: string,
  opts: { text?: string; autoMap: boolean; map?: string[] },
): Promise<void> {
  const allPatterns: string[] = [...(opts.map ?? [])];
  if (opts.text && opts.autoMap) {
    allPatterns.push(...extractPatterns(opts.text));
  }
  if (allPatterns.length === 0) return;

  const unique = [...new Set(allPatterns)];
  try {
    const result = (await client.post(`/api/cli/contexts/${contextId}/map`, {
      patterns: unique,
    })) as { filePatterns: string[] };
    console.log(`Auto-mapped ${result.filePatterns.length} pattern(s):`);
    for (const p of result.filePatterns) {
      console.log(`  ${p}`);
    }
  } catch (err) {
    console.warn(
      `Warning: auto-map failed (${err instanceof Error ? err.message : String(err)}). Use 'prim spec map' to map manually.`,
    );
  }
}
