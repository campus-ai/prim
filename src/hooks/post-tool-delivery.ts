import { getClient } from "../client.js";
import { requireDurableIngestAcknowledgement } from "../ingest-response.js";
import { appendMove } from "../journal.js";
import type { Move } from "../protocol/move.js";

const INGEST_TIMEOUT_MS = 4_000;

/** Write ahead, then attempt the low-latency delivery with the same moveId. */
export async function deliverPostToolMove(move: Move, orgId: string | undefined) {
  appendMove(move, orgId);
  const response = await getClient().post(
    "/api/cli/moves/ingest",
    { batch: [move] },
    { signal: AbortSignal.timeout(INGEST_TIMEOUT_MS) },
  );
  return requireDurableIngestAcknowledgement(response, 1);
}
