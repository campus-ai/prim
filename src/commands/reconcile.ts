/**
 * Record a check-linked resolution. Bare reconcile cannot issue a bypass:
 * command execution and automatic approval review do not prove human consent.
 * STDOUT is JSON; STDERR explains the verdict; rejected bypasses exit 2.
 */

import type { Command } from "commander";
import { HttpError, getClient } from "../client.js";
import { isReconcileResolutionResponse } from "../contract/cli-http-v1.js";

type ReconcileOptions = {
  check?: string;
  outcome?: string;
  flag?: string;
  json?: boolean;
};

const EXIT_USAGE = 2;
const EXIT_SERVER = 3;
const HTTP_CLIENT_ERROR_MIN = 400;
const HTTP_SERVER_ERROR_MIN = 500;

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
  if (opts.check !== undefined || opts.outcome !== undefined) {
    await performResolution(idOrShortId, opts);
    return;
  }
  const message =
    "Overriding a governing Decision requires explicit human approval. This host cannot provide verifiable human approval, so reconcile bypasses are disabled. Keep the edit blocked and choose a compatible change.";
  process.stderr.write(`[prim] reconcile rejected: ${message}\n`);
  console.log(
    JSON.stringify({
      ok: false,
      error: "human_approval_required",
      decisionId: idOrShortId,
      message,
    }),
  );
  process.exitCode = EXIT_USAGE;
}

async function performResolution(idOrShortId: string, opts: ReconcileOptions): Promise<void> {
  if (!opts.check || !["followed", "superseded"].includes(opts.outcome ?? "") || opts.flag) {
    process.stderr.write(
      "[prim] resolution requires --check <checkId> and --outcome followed|superseded; --flag is unsupported because bypasses are disabled\n",
    );
    console.log(JSON.stringify({ ok: false, error: "invalid_resolution_arguments" }));
    process.exitCode = EXIT_USAGE;
    return;
  }
  try {
    const response = await getClient().post("/api/cli/reconcile/resolve", {
      idOrShortId,
      checkId: opts.check,
      outcome: opts.outcome,
    });
    if (
      !isReconcileResolutionResponse(response) ||
      response.checkId !== opts.check ||
      response.outcome !== opts.outcome
    ) {
      process.stderr.write("[prim] resolution: malformed server response\n");
      console.log(JSON.stringify({ ok: false, error: "malformed_response" }));
      process.exitCode = EXIT_SERVER;
      return;
    }
    console.log(JSON.stringify(response, null, 2));
    process.stderr.write(`[prim] recorded ${opts.outcome} for check ${opts.check}\n`);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : undefined;
    process.stderr.write(`[prim] resolution failed${status ? ` (${status})` : ""}\n`);
    console.log(JSON.stringify({ ok: false, status }));
    process.exitCode = isDomainRejection(error) ? EXIT_USAGE : EXIT_SERVER;
  }
}

export function registerReconcileCommands(program: Command): void {
  program
    .command("reconcile <idOrShortId>")
    .description("Record a resolution for Conflict Gates Enforcement; bypasses are disabled")
    .option("--flag <conflictFlagId>", "Legacy bypass flag (always rejected)")
    .option("--check <checkId>", "Original conflict check to resolve; does not issue a bypass")
    .option(
      "--outcome <outcome>",
      "Confirmed resolution: followed or superseded (requires --check)",
    )
    .option("--json", "(reserved; STDOUT is always JSON)")
    .action(async (idOrShortId: string, opts: ReconcileOptions) => {
      await performReconcile(idOrShortId, opts);
    });
}
