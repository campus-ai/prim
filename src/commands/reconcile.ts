/**
 * `prim reconcile <idOrShortId> [--flag <conflictFlagId>] [--json]`
 *
 * Issues a single-use bypass token for a flagged decision so the next
 * conflict-check on a referenced file short-circuits to `allow`. The
 * server marks the latest unacknowledged review flag for the decision
 * as acked; the token expires in 5 minutes.
 *
 * Called by Claude in the cooperative reconcile loop: the PreToolUse
 * hook returns `additionalContext` with a `To reconcile, run: prim
 * reconcile dec_<short>` directive; Claude obeys via the Bash tool
 * (unhooked), then retries the original edit.
 *
 * AX contract: STDOUT machine-readable JSON; STDERR verdict line.
 */

import type { Command } from "commander";
import { getClient } from "../client.js";

type IssueBypassOk = {
  ok: true;
  bypassId: string;
  token: string;
  issuedAt: number;
  expiresAt: number;
  decisionId: string;
  decisionShortId?: string;
  conflictFlagId: string;
};

type IssueBypassResponse = IssueBypassOk | { ok: false; reason: string };

type ReconcileOptions = {
  flag?: string;
  json?: boolean;
};

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_SERVER = 3;

function isOk(value: unknown): value is IssueBypassOk {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.ok === true && typeof v.token === "string" && typeof v.expiresAt === "number";
}

function isReason(value: unknown): value is { ok: false; reason: string } {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.ok === false && typeof v.reason === "string";
}

function formatExpiresIn(expiresAt: number): string {
  const remainingMs = expiresAt - Date.now();
  if (remainingMs <= 0) {
    return "expired";
  }
  const SECONDS_PER_MINUTE = 60;
  const minutes = Math.floor(remainingMs / (SECONDS_PER_MINUTE * 1000));
  const seconds = Math.floor((remainingMs / 1000) % SECONDS_PER_MINUTE);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
}

function renderDecisionIdentifier(short: string | undefined, id: string): string {
  return short ? `dec_${short}` : id;
}

export async function performReconcile(
  idOrShortId: string,
  opts: ReconcileOptions = {},
): Promise<void> {
  const client = getClient();
  const body: Record<string, string> = { idOrShortId };
  if (opts.flag) {
    body.conflictFlagId = opts.flag;
  }
  let response: unknown;
  try {
    response = await client.post("/api/cli/reconcile/consume", body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[prim] reconcile failed: ${message}\n`);
    console.log(JSON.stringify({ ok: false, reason: message }, null, 2));
    process.exitCode = EXIT_SERVER;
    return;
  }

  if (isOk(response)) {
    const ident = renderDecisionIdentifier(response.decisionShortId, response.decisionId);
    process.stderr.write(
      `[prim] reconcile token issued for ${ident} (expires in ${formatExpiresIn(response.expiresAt)})\n`,
    );
    console.log(JSON.stringify(response, null, 2));
    process.exitCode = EXIT_OK;
    return;
  }
  if (isReason(response)) {
    process.stderr.write(`[prim] reconcile rejected: ${response.reason}\n`);
    console.log(JSON.stringify(response, null, 2));
    process.exitCode = EXIT_USAGE;
    return;
  }
  process.stderr.write("[prim] reconcile: malformed server response\n");
  console.log(JSON.stringify({ ok: false, response }, null, 2));
  process.exitCode = EXIT_SERVER;
}

export function registerReconcileCommands(program: Command): void {
  program
    .command("reconcile <idOrShortId>")
    .description(
      "Issue a single-use bypass for a flagged decision (used by the cooperative reconcile loop)",
    )
    .option(
      "--flag <conflictFlagId>",
      "Specific flag id to acknowledge (default: latest unack'd for the decision)",
    )
    .option("--json", "(reserved; STDOUT is always JSON)")
    .action(async (idOrShortId: string, opts: ReconcileOptions) => {
      await performReconcile(idOrShortId, opts);
    });
}
