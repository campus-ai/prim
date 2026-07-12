/**
 * Durable acknowledgement contract for the Moves ingest endpoint.
 *
 * A successful HTTP status is not enough to delete a local journal: older
 * servers returned 200 for disabled capture and other non-persisting states.
 * Only the explicit persisted disposition plus a full-batch acknowledgement
 * proves that every move is durably present (including deduplicated replays).
 */

export interface DurableIngestResponse {
  disposition: "persisted";
  acknowledged: number;
  accepted?: number;
  verdictFooter?: unknown;
}

export class IngestAcknowledgementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IngestAcknowledgementError";
  }
}

export function requireDurableIngestAcknowledgement(
  value: unknown,
  expected: number,
): DurableIngestResponse {
  if (typeof value !== "object" || value === null) {
    throw new IngestAcknowledgementError("ingest response was not an object");
  }
  const response = value as Record<string, unknown>;
  if (response.disposition !== "persisted") {
    throw new IngestAcknowledgementError("ingest response did not confirm persistence");
  }
  if (response.acknowledged !== expected) {
    throw new IngestAcknowledgementError(
      `ingest acknowledged ${String(response.acknowledged)} of ${String(expected)} moves`,
    );
  }
  return value as DurableIngestResponse;
}
