/**
 * Decision Event Pipeline — producer-side PII / secrets scrubbing.
 *
 * Applied at envelope finalization in `prim-hook.ts`, BEFORE the move lands
 * in the journal. Defaults cover the common high-leak surfaces (Bearer
 * tokens, sk- API keys, PRIVATE KEY blocks, Slack/GitHub tokens);
 * per-workspace overrides at `.prim/redaction.json` extend the rule list
 * without touching the binary.
 *
 * Each match becomes `<REDACTED:<reason>>` in place. Reasons are stable so
 * downstream queries can filter on them later.
 *
 * Defense-in-depth note: this is a producer-side filter, not the primary
 * security boundary. The server should still treat any move payload as
 * untrusted and refuse to render redacted strings as clickable links /
 * shell commands / etc.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RedactionRule = {
  pattern: RegExp;
  reason: string;
};

export const DEFAULT_RULES: ReadonlyArray<RedactionRule> = [
  { pattern: /Bearer\s+[A-Za-z0-9._\-]+/g, reason: "bearer-token" },
  { pattern: /sk-[A-Za-z0-9]{32,}/g, reason: "sk-api-key" },
  {
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    reason: "private-key",
  },
  { pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g, reason: "slack-token" },
  { pattern: /ghp_[A-Za-z0-9]{36,}/g, reason: "github-pat" },
];

// Bound the work on the per-tool-call cold path: strings larger than this
// fail CLOSED (redacted wholesale) rather than risk an unscanned
// secret-bearing blob or a catastrophic-backtracking hang from a
// user-supplied workspace pattern.
const MAX_SCRUB_LEN = 256_000;

const WORKSPACE_FILE = ".prim/redaction.json";

type WorkspaceConfig = {
  rules?: Array<{ pattern: string; reason: string; flags?: string }>;
};

function debugRedaction(message: string, err: unknown): void {
  if (!process.env.PRIM_HOOK_DEBUG) {
    return;
  }
  const detail = err instanceof Error ? err.message : String(err);
  process.stderr.write(`[prim-hook] redaction: ${message}: ${detail}\n`);
}

function loadWorkspaceRules(cwd: string): RedactionRule[] {
  const path = join(cwd, WORKSPACE_FILE);
  if (!existsSync(path)) {
    return [];
  }
  let cfg: WorkspaceConfig;
  try {
    cfg = JSON.parse(readFileSync(path, "utf-8")) as WorkspaceConfig;
  } catch (err) {
    // A broken override must not silently disable redaction — surface it
    // (under PRIM_HOOK_DEBUG) and fall back to the defaults.
    debugRedaction(`ignoring unparseable ${WORKSPACE_FILE}`, err);
    return [];
  }
  if (!cfg.rules) {
    return [];
  }
  // Compile rules individually so one invalid pattern doesn't drop the
  // rest (the previous all-or-nothing catch silently disabled every
  // override on a single bad regex).
  const compiled: RedactionRule[] = [];
  for (const r of cfg.rules) {
    try {
      compiled.push({ pattern: new RegExp(r.pattern, r.flags ?? "g"), reason: r.reason });
    } catch (err) {
      debugRedaction(`skipping invalid redaction rule "${r.reason}"`, err);
    }
  }
  return compiled;
}

function applyRules(input: string, rules: ReadonlyArray<RedactionRule>): string {
  if (input.length > MAX_SCRUB_LEN) {
    return "<REDACTED:oversized>";
  }
  let out = input;
  for (const rule of rules) {
    out = out.replace(rule.pattern, `<REDACTED:${rule.reason}>`);
  }
  return out;
}

/**
 * Recursively walks the payload and rewrites every string field in-place
 * against the supplied rules. Non-string scalars and shapes pass through
 * unchanged.
 */
export function scrub(
  value: unknown,
  rules: ReadonlyArray<RedactionRule> = DEFAULT_RULES,
): unknown {
  if (typeof value === "string") {
    return applyRules(value, rules);
  }
  if (Array.isArray(value)) {
    return value.map((v) => scrub(v, rules));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = scrub(v, rules);
    }
    return out;
  }
  return value;
}

/**
 * One-shot helper used by `prim-hook.ts`. Resolves workspace overrides from
 * `cwd` and applies them in addition to the defaults.
 */
export function scrubFromCwd(value: unknown, cwd: string): unknown {
  const rules = [...DEFAULT_RULES, ...loadWorkspaceRules(cwd)];
  return scrub(value, rules);
}
