/**
 * `prim reconcile <idOrShortId> [--flag <conflictFlagId>] [--json]`
 *
 * Mints a single-use, decision-scoped reconcile bypass for the calling user.
 * The bypass is NOT a token to present — it is consumed automatically as a
 * side effect of this caller's NEXT conflict-check on a file the decision
 * references, excluding that one decision from scoring. It expires in 5
 * minutes. `bypassId` is an audit id, not a secret.
 *
 * Used by Claude in the cooperative reconcile loop: the PreToolUse hook
 * returns `additionalContext` with a "To reconcile, run: prim reconcile
 * dec_<short>" directive; Claude runs it via the Bash tool (unhooked), then
 * retries the original edit, which now passes.
 *
 * Exit codes: 0 issued/reissued · 2 rejected (no pending flag, decision not
 * found, org-unbound, …) · 3 transport / server error.
 *
 * AX contract: STDOUT machine-readable JSON; STDERR verdict line.
 */

import type { Command } from "commander";
import { HttpError, getClient } from "../client.js";

type IssueBypassOk = {
  ok: true;
  bypassId: string;
  decisionId: string;
  decisionShortId?: string;
  // Undefined for a flag-less bypass: a load-bearing active-decision deny has
  // no review flag, and issuance still succeeds.
  conflictFlagId?: string;
  issuedAt: number;
  expiresAt: number;
  // True when an unconsumed bypass for this (user, decision) already existed
  // and was returned instead of minting a second one.
  reissued: boolean;
};

type ReconcileOptions = {
  flag?: string;
  json?: boolean;
};

const EXIT_OK = 0;
const EXIT_USAGE = 2;
const EXIT_SERVER = 3;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

function isOk(value: unknown): value is IssueBypassOk {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const v = value as Record<string, unknown>;
  return v.ok === true && typeof v.bypassId === "string" && typeof v.expiresAt === "number";
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

/**
 * A 4xx is a domain rejection the caller can act on (no pending flag, decision
 * not found, ambiguous short id, org-unbound) → exit 2. Anything else — a 5xx,
 * a network failure, a malformed body — is a transport/server problem → exit 3.
 */
function isDomainRejection(err: unknown): err is HttpError {
  return (
    err instanceof HttpError &&
    err.status >= HTTP_CLIENT_ERROR_MIN &&
    err.status < HTTP_SERVER_ERROR_MIN
  );
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
    response = await client.post("/api/cli/reconcile/issue", body);
  } catch (err) {
    if (isDomainRejection(err)) {
      process.stderr.write(`[prim] reconcile rejected: ${err.message}\n`);
      console.log(JSON.stringify({ ok: false, status: err.status, error: err.message }, null, 2));
      process.exitCode = EXIT_USAGE;
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[prim] reconcile failed: ${message}\n`);
    console.log(JSON.stringify({ ok: false, error: message }, null, 2));
    process.exitCode = EXIT_SERVER;
    return;
  }

  if (isOk(response)) {
    const ident = renderDecisionIdentifier(response.decisionShortId, response.decisionId);
    const verb = response.reissued ? "reissued" : "issued";
    process.stderr.write(
      `[prim] reconcile bypass ${verb} for ${ident} (expires in ${formatExpiresIn(response.expiresAt)})\n`,
    );
    console.log(JSON.stringify(response, null, 2));
    process.exitCode = EXIT_OK;
    return;
  }

  process.stderr.write("[prim] reconcile: malformed server response\n");
  console.log(JSON.stringify({ ok: false, response }, null, 2));
  process.exitCode = EXIT_SERVER;
}

export function registerReconcileCommands(program: Command): void {
  program
    .command("reconcile <idOrShortId>")
    .description("Issue a single-use bypass for a decision flagged by Conflict Gates Enforcement")
    .option(
      "--flag <conflictFlagId>",
      "Specific flag id to bind the bypass to (default: the decision's latest unack'd flag)",
    )
    .option("--json", "(reserved; STDOUT is always JSON)")
    .action(async (idOrShortId: string, opts: ReconcileOptions) => {
      await performReconcile(idOrShortId, opts);
    });
}
