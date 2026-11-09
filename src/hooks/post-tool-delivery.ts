import { getClient, getPinnedClient } from "../client.js";
import { requireDurableIngestAcknowledgement } from "../ingest-response.js";
import {
  InvalidJournalEnvelopeError,
  buildOrganizationBoundMoveRequest,
  parseOrganizationBinding,
} from "../journal-organization.js";
import { appendMove } from "../journal.js";
import type { Move } from "../protocol/move.js";

const INGEST_TIMEOUT_MS = 4_000;

/** Write ahead, then attempt the low-latency delivery with the same moveId. */
export async function deliverPostToolMove(move: Move, orgId: string | undefined) {
  const captured = appendMove(move, orgId);
  const signal = AbortSignal.timeout(INGEST_TIMEOUT_MS);
  // Preserve the original capture identity across configuration changes and
  // bind status and upload to the same principal, just as the journal drain does.
  const client = captured.captureActor ? await getPinnedClient({ signal }) : getClient();
  let request: unknown = { batch: [captured] };
  if (captured.captureActor) {
    const binding = parseOrganizationBinding(
      await client.get("/api/cli/auth/status", { signal, quietRefresh: true }),
    );
    if (binding.state !== "current") throw new InvalidJournalEnvelopeError();
    request = buildOrganizationBoundMoveRequest([captured], binding.binding);
  }
  const response = await client.post("/api/cli/moves/ingest", request, { signal });
  return requireDurableIngestAcknowledgement(response, 1, move.env.gitRoot ?? move.env.cwd);
}
