import { type CliClient, getPinnedClient } from "./client.js";
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

/** A local WAL record cannot be safely projected into the contract envelope. */
export class InvalidJournalEnvelopeError extends Error {
  constructor() {
    super("Invalid locally journaled move");
    this.name = "InvalidJournalEnvelopeError";
  }
}

function safeOrganizationId(value: unknown): value is string {
  return typeof value === "string" && ORGANIZATION_ID_RE.test(value);
}

function isCaptureAuthorityKind(
  value: unknown,
): value is CurrentOrganizationBinding["captureAuthorityKind"] {
  return value === "workos" || value === "service_token";
}

/**
 * The auth-status endpoint is the authority source, so accept only its exact
 * versioned tuple. Any older or malformed response retains durable records
 * before a rotation or upload can begin.
 */
export function parseOrganizationBinding(value: unknown): ParsedOrganizationBinding {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { state: "server_contract_unavailable" };
  }
  const record = value as Record<string, unknown>;
  if (
    record.authenticated !== true ||
    record.organizationBindingVersion !== ORGANIZATION_BINDING_VERSION ||
    !isCaptureAuthorityKind(record.captureAuthorityKind)
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
 * Project immutable WAL records into the current authority-bound wire shape.
 * The source journal is never rewritten: a retry must bind the same local
 * event bytes to the credential generation that actually delivers it.
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
    throw new InvalidJournalEnvelopeError();
  }
  return request;
}

/**
 * Freeze one bearer generation, obtain its exact organization tuple, and
 * classify every bucket before any journal rotation or ingest POST occurs.
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
