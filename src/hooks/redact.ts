/**
 * Decision Event Pipeline — producer-side PII / secrets scrubbing.
 *
 * Built-in rules run synchronously before a move reaches the journal. Optional
 * workspace rules from `.prim/redaction.json` run in an isolated worker with a
 * hard deadline, so an unsafe regular expression cannot stall the hook.
 */

import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Worker } from "node:worker_threads";

export type RedactionRule = {
  pattern: RegExp;
  reason: string;
  replacement?: string;
};

const USER_HOME_RULES: ReadonlyArray<RedactionRule> = [
  {
    pattern: /\/Users\/[^/\\\s"'`]+/g,
    reason: "user-home-path",
    replacement: "/Users/__redacted_user__",
  },
  {
    pattern: /\/home\/[^/\\\s"'`]+/g,
    reason: "user-home-path",
    replacement: "/home/__redacted_user__",
  },
  {
    pattern: /([A-Za-z]:\\Users\\)[^/\\\s"'`]+/gi,
    reason: "user-home-path",
    replacement: "$1__redacted_user__",
  },
  {
    pattern: /\/root(?=\/|$)/g,
    reason: "user-home-path",
    replacement: "/__redacted_user__",
  },
];

export const DEFAULT_RULES: ReadonlyArray<RedactionRule> = [
  { pattern: /Bearer\s+[A-Za-z0-9._~+/=-]+/gi, reason: "bearer-token" },
  {
    pattern: /\bsk-(?:(?:ant|proj)-)?[A-Za-z0-9_-]{16,}(?![A-Za-z0-9_-])/g,
    reason: "sk-api-key",
  },
  {
    pattern: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
    reason: "private-key",
  },
  { pattern: /xox[abprs]-[A-Za-z0-9-]{10,}/g, reason: "slack-token" },
  {
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{50,})\b/g,
    reason: "github-pat",
  },
  { pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g, reason: "aws-access-key" },
  {
    pattern: /\bAWS_(?:SECRET_ACCESS_KEY|SESSION_TOKEN)"?\s*[:=]\s*["']?[A-Za-z0-9/+=]{20,}["']?/gi,
    reason: "aws-secret",
  },
  { pattern: /\bAIza[0-9A-Za-z_-]{35}(?![0-9A-Za-z_-])/g, reason: "gcp-api-key" },
  {
    pattern: /\bya29\.[0-9A-Za-z_-]{20,}(?![0-9A-Za-z_-])/g,
    reason: "gcp-oauth-token",
  },
  {
    pattern: /\beyJ[A-Za-z0-9_-]*\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*(?![A-Za-z0-9_-])/g,
    reason: "jwt",
  },
  { pattern: /\bBasic\s+[A-Za-z0-9+/]+={0,2}/gi, reason: "basic-auth" },
  { pattern: /\bhttps?:\/\/[^/\s:@]+:[^/\s@]+@/gi, reason: "basic-auth" },
  ...USER_HOME_RULES,
];

// Bound producer work before any regular expression sees a string. Workspace
// rules receive a separate wall-clock bound below.
const MAX_SCRUB_LEN = 256_000;
const MAX_WORKSPACE_CONFIG_BYTES = 64 * 1024;
const MAX_WORKSPACE_RULES = 32;
const MAX_WORKSPACE_PATTERN_LENGTH = 512;
const MAX_WORKSPACE_REASON_LENGTH = 64;
const WORKSPACE_RULE_TIMEOUT_MS = 250;
const WORKSPACE_FILE = ".prim/redaction.json";
const SAFE_REASON_RE = /^[A-Za-z0-9][A-Za-z0-9_-]*$/u;
const SAFE_WORKSPACE_FLAGS_RE = /^[gimsu]*$/u;

type WorkspaceConfig = {
  rules?: Array<{ pattern?: unknown; reason?: unknown; flags?: unknown }>;
};

type SerializableRule = {
  source: string;
  flags: string;
  reason: string;
};

function debugRedaction(message: string): void {
  if (!process.env.PRIM_HOOK_DEBUG) return;
  // Do not include exception messages here: RegExp syntax errors echo the raw
  // pattern, which may itself contain the secret the author meant to remove.
  process.stderr.write(`[prim-hook] redaction: ${message}\n`);
}

function normalizedWorkspaceFlags(value: unknown): string | null {
  if (value !== undefined && typeof value !== "string") return null;
  const requested = value ?? "";
  if (!SAFE_WORKSPACE_FLAGS_RE.test(requested)) return null;
  return [...new Set(`g${requested}`)].sort().join("");
}

function loadWorkspaceRules(cwd: string): RedactionRule[] {
  const path = join(cwd, WORKSPACE_FILE);
  if (!existsSync(path)) return [];
  let cfg: WorkspaceConfig;
  try {
    if (statSync(path).size > MAX_WORKSPACE_CONFIG_BYTES) {
      debugRedaction(`ignoring oversized ${WORKSPACE_FILE}`);
      return [];
    }
    cfg = JSON.parse(readFileSync(path, "utf-8")) as WorkspaceConfig;
  } catch {
    debugRedaction(`ignoring unparseable ${WORKSPACE_FILE}`);
    return [];
  }
  if (!Array.isArray(cfg.rules)) return [];

  const compiled: RedactionRule[] = [];
  for (const candidate of cfg.rules.slice(0, MAX_WORKSPACE_RULES)) {
    if (!candidate || typeof candidate !== "object") continue;
    const { pattern, reason } = candidate;
    const flags = normalizedWorkspaceFlags(candidate.flags);
    if (
      typeof pattern !== "string" ||
      pattern.length === 0 ||
      pattern.length > MAX_WORKSPACE_PATTERN_LENGTH ||
      typeof reason !== "string" ||
      reason.length === 0 ||
      reason.length > MAX_WORKSPACE_REASON_LENGTH ||
      !SAFE_REASON_RE.test(reason) ||
      flags === null
    ) {
      debugRedaction("skipping invalid workspace rule metadata");
      continue;
    }
    try {
      compiled.push({ pattern: new RegExp(pattern, flags), reason });
    } catch {
      debugRedaction(`skipping invalid workspace rule ${reason}`);
    }
  }
  return compiled;
}

function applyRules(input: string, rules: ReadonlyArray<RedactionRule>): string {
  if (input.length > MAX_SCRUB_LEN) return "<REDACTED:oversized>";
  let out = input;
  for (const rule of rules) {
    out = out.replace(rule.pattern, rule.replacement ?? `<REDACTED:${rule.reason}>`);
  }
  return out;
}

function mapStrings(value: unknown, transform: (input: string) => string): unknown {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return value.map((item) => mapStrings(item, transform));
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      out[key] = mapStrings(item, transform);
    }
    return out;
  }
  return value;
}

/** Recursively scrub strings while preserving the payload's JSON shape. */
export function scrub(
  value: unknown,
  rules: ReadonlyArray<RedactionRule> = DEFAULT_RULES,
): unknown {
  return mapStrings(value, (input) => applyRules(input, rules));
}

function redactEveryString(value: unknown, reason: string): unknown {
  return mapStrings(value, () => `<REDACTED:${reason}>`);
}

const WORKSPACE_REDACTION_WORKER = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const rules = workerData.rules.map((rule) => ({
    pattern: new RegExp(rule.source, rule.flags),
    reason: rule.reason,
  }));
  function walk(value) {
    if (typeof value === "string") {
      let output = value;
      for (const rule of rules) {
        output = output.replace(rule.pattern, "<REDACTED:" + rule.reason + ">");
      }
      return output;
    }
    if (Array.isArray(value)) return value.map(walk);
    if (value && typeof value === "object") {
      const output = {};
      for (const [key, item] of Object.entries(value)) output[key] = walk(item);
      return output;
    }
    return value;
  }
  parentPort.postMessage(walk(workerData.value));
`;

function applyWorkspaceRules(
  value: unknown,
  rules: ReadonlyArray<RedactionRule>,
): Promise<unknown> {
  const serialized: SerializableRule[] = rules.map(({ pattern, reason }) => ({
    source: pattern.source,
    flags: pattern.flags,
    reason,
  }));
  return new Promise((resolve) => {
    let worker: Worker;
    try {
      worker = new Worker(WORKSPACE_REDACTION_WORKER, {
        eval: true,
        workerData: { value, rules: serialized },
      });
    } catch {
      resolve(redactEveryString(value, "workspace-rule-failed"));
      return;
    }
    let settled = false;
    const finish = (result: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void worker.terminate();
      resolve(result);
    };
    const failClosed = (): void => finish(redactEveryString(value, "workspace-rule-failed"));
    const timer = setTimeout(failClosed, WORKSPACE_RULE_TIMEOUT_MS);
    worker.once("message", finish);
    worker.once("error", failClosed);
    worker.once("exit", (code) => {
      if (code !== 0) failClosed();
    });
  });
}

/**
 * Apply defaults, then bounded workspace overrides. A timed-out or failed
 * custom rule redacts every remaining string rather than leaking the payload.
 */
export async function scrubFromCwd(value: unknown, cwd: string): Promise<unknown> {
  const defaultScrubbed = scrub(value, DEFAULT_RULES);
  const workspaceRules = loadWorkspaceRules(cwd);
  return workspaceRules.length === 0
    ? defaultScrubbed
    : await applyWorkspaceRules(defaultScrubbed, workspaceRules);
}

/**
 * Remove user-home identity from local path fields without touching repository
 * IDs, canonical file refs, or other correlation keys.
 */
export function scrubEnvironmentPaths<
  T extends { cwd: string; repoRoot?: string; gitRoot?: string },
>(environment: T): T {
  const scrubPath = (value: string | undefined): string | undefined =>
    value === undefined ? undefined : applyRules(value, USER_HOME_RULES);
  return {
    ...environment,
    cwd: scrubPath(environment.cwd) ?? environment.cwd,
    ...(environment.repoRoot === undefined ? {} : { repoRoot: scrubPath(environment.repoRoot) }),
    ...(environment.gitRoot === undefined ? {} : { gitRoot: scrubPath(environment.gitRoot) }),
  };
}
