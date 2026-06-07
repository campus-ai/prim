/**
 * `prim decisions confirm <idOrShortId> [--reject]` — acknowledge a
 * Phase C confirmation prompt without touching the browser.
 *
 * Default behavior is "yes, the inferred rationale is correct" —
 * `--reject` flips the bit to `confirmed=false`. Idempotent: re-call
 * returns `alreadyAcknowledged=true` with the original flagId so the
 * caller can tell the difference between "just acked" and "already
 * acked." Exit 0 in either case.
 */

import { type CliClient, getClient } from "../client.js";
import { renderIdentifier } from "./recent.js";

export interface ConfirmResult {
  decisionId: string;
  shortId: string | undefined;
  confirmed: boolean;
  flagId: string | null;
  alreadyAcknowledged: boolean;
}

export const CONFIRM_TIMEOUT_MS = 10_000;

export interface ConfirmDeps {
  getClient: () => CliClient;
}

const defaultDeps: ConfirmDeps = { getClient };

export class ConfirmNotFoundError extends Error {
  constructor(idOrShortId: string) {
    super(`Decision not found: ${idOrShortId}`);
    this.name = "ConfirmNotFoundError";
  }
}

export async function fetchConfirm(
  idOrShortId: string,
  confirmed: boolean,
  deps: ConfirmDeps = defaultDeps,
): Promise<ConfirmResult> {
  const client = deps.getClient();
  try {
    return (await client.post(
      "/api/cli/decisions/confirm",
      { id: idOrShortId, confirmed },
      { signal: AbortSignal.timeout(CONFIRM_TIMEOUT_MS) },
    )) as ConfirmResult;
  } catch (err) {
    if (err instanceof Error && /not found/i.test(err.message)) {
      throw new ConfirmNotFoundError(idOrShortId);
    }
    throw err;
  }
}

export function formatConfirmHuman(result: ConfirmResult): string {
  const id = renderIdentifier({
    shortId: result.shortId,
    id: result.decisionId,
  });
  if (result.alreadyAcknowledged) {
    return `[prim] ${id} was already acknowledged (confirmed=${String(result.confirmed)}).`;
  }
  if (result.flagId === null) {
    return `[prim] ${id} has no pending confirmation request — nothing to acknowledge (current confirmed=${String(result.confirmed)}).`;
  }
  return `[prim] ${id} acknowledged (confirmed=${String(result.confirmed)}).`;
}

export function formatConfirmJson(result: ConfirmResult): string {
  return JSON.stringify(result, null, 2);
}
