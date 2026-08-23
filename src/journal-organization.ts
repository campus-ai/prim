import { type CliClient, HttpError, getPinnedClient } from "./client.js";
import { type MoveIngestRequest, isMoveIngestRequest } from "./contract/cli-http-v1.js";
import { DECISION_LIFECYCLE_PROTOCOL_VERSION } from "./protocol/decision-lifecycle.js";
import type { Move } from "./protocol/move.js";

const ORGANIZATION_BINDING_VERSION = 1;
const ORGANIZATION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const UNBOUND_BUCKET = "_unbound";

export type JournalRetentionReason =
  | "identity_unavailable"
  | "no_current_organization"
  | "organization_identity_unreconciled"
  | "organization_mismatch"
  | "server_contract_unavailable"
  | "unbound";

export type RetainedJournalBucket = {
  bucket: string;
  reason: JournalRetentionReason;
};

export type CurrentOrganizationBinding = {
  captureAuthorityKind: "workos" | "service_token";
  organizationId: string;
  workosOrganizationId: string;
};

type ParsedOrganizationBinding =
  | { state: "current"; binding: CurrentOrganizationBinding }
  | { state: "no_current_organization" }
  | { state: "organization_identity_unreconciled" }
  | { state: "server_contract_unavailable" };

export type JournalDeliveryInspection = {
  client?: CliClient;
  binding?: CurrentOrganizationBinding;
  deliverableBuckets: Set<string>;
  retainedBuckets: RetainedJournalBucket[];
};

function safeOrganizationId(value: unknown): value is string {
  return typeof value === "string" && ORGANIZATION_ID_RE.test(value);
}

export function parseOrganizationBinding(value: unknown): ParsedOrganizationBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { state: "server_contract_unavailable" };
  }
  const record = value as Record<string, unknown>;
  if (
    record.authenticated !== true ||
    record.organizationBindingVersion !== ORGANIZATION_BINDING_VERSION
  ) {
    return { state: "server_contract_unavailable" };
  }
  if (record.organizationId === null && record.workosOrganizationId === null) {
    return { state: "no_current_organization" };
  }
  if (safeOrganizationId(record.organizationId) && record.workosOrganizationId === null) {
    return { state: "organization_identity_unreconciled" };
  }
  if (
    (record.captureAuthorityKind !== "workos" && record.captureAuthorityKind !== "service_token") ||
    !safeOrganizationId(record.organizationId) ||
    !safeOrganizationId(record.workosOrganizationId)
  ) {
    return { state: "server_contract_unavailable" };
  }
  return {
    state: "current",
    binding: {
      captureAuthorityKind: record.captureAuthorityKind,
      organizationId: record.organizationId,
      workosOrganizationId: record.workosOrganizationId,
    },
  };
}

export function classifyJournalBuckets(
  buckets: Iterable<string>,
  binding: CurrentOrganizationBinding | JournalRetentionReason,
): Pick<JournalDeliveryInspection, "deliverableBuckets" | "retainedBuckets"> {
  const deliverableBuckets = new Set<string>();
  const retainedBuckets: RetainedJournalBucket[] = [];
  for (const bucket of [...new Set(buckets)].sort()) {
    if (bucket === UNBOUND_BUCKET) {
      retainedBuckets.push({ bucket, reason: "unbound" });
      continue;
    }
    if (typeof binding === "string") {
      retainedBuckets.push({ bucket, reason: binding });
      continue;
    }
    if (bucket === binding.organizationId || bucket === binding.workosOrganizationId) {
      deliverableBuckets.add(bucket);
    } else {
      retainedBuckets.push({ bucket, reason: "organization_mismatch" });
    }
  }
  return { deliverableBuckets, retainedBuckets };
}

/**
 * Project a durable legacy journal batch into the current authority-bound wire
 * envelope. The WAL is intentionally left untouched: a later retry must bind
 * the same immutable event bytes to the credential generation that actually
 * sends them.
 */
export function buildOrganizationBoundMoveRequest(
  batch: Move[],
  binding: CurrentOrganizationBinding,
): MoveIngestRequest {
  const capturedOrganizationId =
    binding.captureAuthorityKind === "workos"
      ? binding.workosOrganizationId
      : binding.organizationId;
  const request: unknown = {
    batch: batch.map((move) => {
      if (typeof move !== "object" || move === null || Array.isArray(move)) {
        return move;
      }
      return {
        ...move,
        envelopeVersion: 4,
        capturedOrganizationId,
        captureAuthorityKind: binding.captureAuthorityKind,
        decisionLifecycleProtocolVersion: DECISION_LIFECYCLE_PROTOCOL_VERSION,
      };
    }),
  };
  if (!isMoveIngestRequest(request)) {
    throw new HttpError(400, "Invalid locally journaled move", {
      error: "invalid_move",
    });
  }
  return request;
}

/**
 * Resolve one bearer generation, fetch its exact tenant tuple, and classify
 * every bucket before any journal rotation or POST occurs.
 */
export async function inspectJournalDelivery(
  buckets: Iterable<string>,
  options: {
    client?: CliClient;
    createClient?: () => Promise<CliClient>;
  } = {},
): Promise<JournalDeliveryInspection> {
  const bucketList = [...new Set(buckets)];
  let client: CliClient;
  try {
    client = options.client ?? (await (options.createClient ?? (() => getPinnedClient()))());
  } catch {
    return classifyJournalBuckets(bucketList, "identity_unavailable");
  }
  let parsed: ParsedOrganizationBinding;
  try {
    parsed = parseOrganizationBinding(
      await client.get("/api/cli/auth/status", {
        signal: AbortSignal.timeout(10_000),
        quietRefresh: true,
      }),
    );
  } catch {
    return classifyJournalBuckets(bucketList, "identity_unavailable");
  }
  if (parsed.state !== "current") {
    return classifyJournalBuckets(bucketList, parsed.state);
  }
  return {
    client,
    binding: parsed.binding,
    ...classifyJournalBuckets(bucketList, parsed.binding),
  };
}
