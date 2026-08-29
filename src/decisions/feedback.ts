import { type CliClient, getClient } from "../client.js";
import { isTerminalSafeText, terminalSafeLine, terminalSafeText } from "../lib/terminal-safe.js";

// Protocol v2 adds a required event kind so author-private drafts can be
// rendered as a publish action rather than confirmation feedback. Keep
// parsing v1 responses during a rolling upgrade, but advertise v2 for every
// new lease request.
export const FEEDBACK_PROTOCOL_VERSION = 2;
const FEEDBACK_MIN_PROTOCOL_VERSION = 1;
export const FEEDBACK_DEADLINE_MS = 3_000;
export const MAX_FEEDBACK_EVENTS = 40;
export const MAX_FEEDBACK_MESSAGE_CODE_POINTS = 8_000;
export const MAX_FEEDBACK_INTENT_CODE_POINTS = 180;

const LEASE_PATH = "/api/cli/decisions/feedback/lease";
const ACK_PATH = "/api/cli/decisions/feedback/ack";
const STATUS_PATH = "/api/cli/decisions/feedback/status";
const SHORT_ID = /^[0-9a-f]{8}$/u;
const MAX_EVENT_ID_CHARS = 128;
const MAX_RAW_INTENT_CODE_UNITS = 512;
const MAX_FEEDBACK_WEB_URL_CHARS = 2_048;
const SAFE_PUBLISH_DECISION_ID = /^[A-Za-z0-9_-]+$/u;

export type FeedbackDeliveryToken = {
  eventId: string;
  leaseVersion: number;
};

export type FeedbackProtocolVersion = 1 | 2;

export type FeedbackKind = "confirm_prompt" | "publish_prompt";

export type FeedbackEvent = FeedbackDeliveryToken & {
  shortId: string;
  /** Full unambiguous identifier supplied only for a v2 publish prompt. */
  decisionId?: string;
  intent: string;
  webUrl?: string;
  kind: FeedbackKind;
};

export type FeedbackLease = {
  protocolVersion: FeedbackProtocolVersion;
  events: FeedbackEvent[];
  hasMore: boolean;
};

export type RenderedFeedback = {
  protocolVersion: FeedbackProtocolVersion;
  systemMessage: string;
  deliveries: FeedbackDeliveryToken[];
};

export type FeedbackCapability =
  | { status: "available" }
  | { status: "unavailable"; reason: "organization_unbound" };

type FeedbackClient = Pick<CliClient, "get" | "post">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSupportedProtocolVersion(value: unknown): value is FeedbackProtocolVersion {
  return (
    Number.isSafeInteger(value) &&
    Number(value) >= FEEDBACK_MIN_PROTOCOL_VERSION &&
    Number(value) <= FEEDBACK_PROTOCOL_VERSION
  );
}

/** Normalize untrusted display text without changing ordinary Unicode prose. */
export function normalizeFeedbackIntent(value: string): string {
  const withoutControls = terminalSafeLine(value);
  const points = Array.from(withoutControls);
  if (points.length <= MAX_FEEDBACK_INTENT_CODE_POINTS) {
    return withoutControls;
  }
  return `${points.slice(0, MAX_FEEDBACK_INTENT_CODE_POINTS - 1).join("")}…`;
}

function parseFeedbackWebUrl(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_FEEDBACK_WEB_URL_CHARS ||
    !/^https:\/\//iu.test(value) ||
    /\s/u.test(value) ||
    !isTerminalSafeText(value)
  ) {
    return undefined;
  }
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username.length > 0 ||
      url.password.length > 0
    ) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return value;
}

/**
 * A publish prompt is rendered as inline shell syntax. Restrict its opaque
 * argument to a literal command-token alphabet so quotes, backticks, spaces,
 * and shell operators cannot turn a server value into a spoofed action.
 */
function parseFeedbackDecisionId(value: unknown): string | undefined {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > MAX_EVENT_ID_CHARS ||
    terminalSafeText(value) !== value ||
    !SAFE_PUBLISH_DECISION_ID.test(value)
  ) {
    return undefined;
  }
  return value;
}

function parseEvent(
  value: unknown,
  protocolVersion: FeedbackProtocolVersion,
): FeedbackEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.eventId !== "string" ||
    value.eventId.length === 0 ||
    value.eventId.length > MAX_EVENT_ID_CHARS ||
    terminalSafeText(value.eventId) !== value.eventId
  ) {
    return undefined;
  }
  if (!Number.isSafeInteger(value.leaseVersion) || Number(value.leaseVersion) < 1) {
    return undefined;
  }
  if (typeof value.shortId !== "string" || !SHORT_ID.test(value.shortId)) {
    return undefined;
  }
  if (typeof value.intent !== "string" || value.intent.length > MAX_RAW_INTENT_CODE_UNITS) {
    return undefined;
  }
  const intent = normalizeFeedbackIntent(value.intent);
  if (!intent) return undefined;
  const webUrl = value.webUrl === undefined ? undefined : parseFeedbackWebUrl(value.webUrl);
  if (value.webUrl !== undefined && webUrl === undefined) return undefined;
  const kind = value.kind === undefined && protocolVersion === 1 ? "confirm_prompt" : value.kind;
  if (kind !== "confirm_prompt" && kind !== "publish_prompt") return undefined;
  // A v1 caller cannot truthfully consume publish prompts. The server already
  // withholds them; enforce that boundary locally so a malformed response is
  // never acknowledged under the legacy dialect.
  if (protocolVersion === 1 && kind === "publish_prompt") return undefined;

  const decisionId =
    value.decisionId === undefined ? undefined : parseFeedbackDecisionId(value.decisionId);
  if (value.decisionId !== undefined && decisionId === undefined) return undefined;
  // Full action targets are scoped to v2 publish events. Reject an unexpected
  // value rather than silently accepting a protocol shape that later versions
  // may mean differently.
  if (decisionId !== undefined && (protocolVersion !== 2 || kind !== "publish_prompt")) {
    return undefined;
  }
  // Never build an inline command from an ambiguous short id or a malformed
  // full id. Returning no lease leaves the entire delivery unacknowledged for
  // a safe redelivery after the server data is repaired.
  if (protocolVersion === 2 && kind === "publish_prompt" && decisionId === undefined) {
    return undefined;
  }
  return {
    eventId: value.eventId,
    leaseVersion: Number(value.leaseVersion),
    shortId: value.shortId,
    intent,
    ...(webUrl === undefined ? {} : { webUrl }),
    ...(decisionId === undefined ? {} : { decisionId }),
    kind,
  };
}

export function parseFeedbackLease(value: unknown): FeedbackLease | undefined {
  if (!isRecord(value) || !isSupportedProtocolVersion(value.protocolVersion)) return undefined;
  const protocolVersion = value.protocolVersion;
  if (value.status === "empty") {
    return value.hasMore === false ? { protocolVersion, events: [], hasMore: false } : undefined;
  }
  if (value.status === "unavailable") {
    return value.reason === "organization_unbound"
      ? { protocolVersion, events: [], hasMore: false }
      : undefined;
  }
  if (value.status !== "leased" || typeof value.hasMore !== "boolean") return undefined;
  if (
    !Array.isArray(value.events) ||
    value.events.length === 0 ||
    value.events.length > MAX_FEEDBACK_EVENTS
  ) {
    return undefined;
  }
  const events = value.events.map((event) => parseEvent(event, protocolVersion));
  if (events.some((event) => event === undefined)) return undefined;
  const parsedEvents = events as FeedbackEvent[];
  if (new Set(parsedEvents.map((event) => event.eventId)).size !== parsedEvents.length) {
    return undefined;
  }
  return { protocolVersion, events: parsedEvents, hasMore: value.hasMore };
}

export function renderFeedback(lease: FeedbackLease): RenderedFeedback | undefined {
  const lines: string[] = [];
  const deliveries: FeedbackDeliveryToken[] = [];
  let pointCount = 0;
  for (const event of lease.events) {
    const decisionId =
      event.kind === "publish_prompt" ? parseFeedbackDecisionId(event.decisionId) : undefined;
    // This protects callers that construct FeedbackLease directly as well as
    // the normal parse path: an unsafe action is neither printed nor acked.
    if (event.kind === "publish_prompt" && decisionId === undefined) continue;
    const identifier = `dec_${event.shortId}`;
    const detail = `${event.intent}${event.webUrl ? ` (${event.webUrl})` : ""}`;
    const line =
      event.kind === "publish_prompt"
        ? `[prim] publish this Decision draft (${identifier})? ${detail} Run \`prim decisions publish ${decisionId}\` to share it with your team.`
        : `[prim] response → created Decision (${identifier}): ${detail}`;
    const extra = Array.from(line).length + (lines.length === 0 ? 0 : 1);
    if (pointCount + extra > MAX_FEEDBACK_MESSAGE_CODE_POINTS) break;
    lines.push(line);
    deliveries.push({ eventId: event.eventId, leaseVersion: event.leaseVersion });
    pointCount += extra;
  }
  if (lines.length === 0) return undefined;
  return { protocolVersion: lease.protocolVersion, systemMessage: lines.join("\n"), deliveries };
}

export async function leaseDecisionFeedback(
  input: { workspaceId: string; currentSessionId: string; signal: AbortSignal },
  dependencies: { client?: FeedbackClient; onError?: (error: unknown) => void } = {},
): Promise<FeedbackLease | undefined> {
  try {
    const response = await (dependencies.client ?? getClient()).post(
      LEASE_PATH,
      {
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        workspaceId: input.workspaceId,
        currentSessionId: input.currentSessionId,
      },
      { signal: input.signal, quietRefresh: true },
    );
    const parsed = parseFeedbackLease(response);
    if (!parsed) {
      dependencies.onError?.(
        new Error("server returned an unsupported decision-feedback contract"),
      );
    }
    return parsed;
  } catch (error) {
    dependencies.onError?.(error);
    return undefined;
  }
}

export async function acknowledgeDecisionFeedback(
  input: {
    protocolVersion: FeedbackProtocolVersion;
    workspaceId: string;
    deliveries: FeedbackDeliveryToken[];
    signal: AbortSignal;
  },
  dependencies: { client?: FeedbackClient; onError?: (error: unknown) => void } = {},
): Promise<boolean> {
  if (
    !isSupportedProtocolVersion(input.protocolVersion) ||
    input.deliveries.length === 0 ||
    input.deliveries.length > MAX_FEEDBACK_EVENTS
  ) {
    return false;
  }
  try {
    const response = await (dependencies.client ?? getClient()).post(
      ACK_PATH,
      {
        protocolVersion: input.protocolVersion,
        workspaceId: input.workspaceId,
        deliveries: input.deliveries,
      },
      { signal: input.signal, quietRefresh: true },
    );
    const acknowledgedEventIds = isRecord(response) ? response.acknowledgedEventIds : undefined;
    const expectedEventIds = new Set(input.deliveries.map((delivery) => delivery.eventId));
    const valid =
      isRecord(response) &&
      response.protocolVersion === input.protocolVersion &&
      response.status === "acked" &&
      Array.isArray(acknowledgedEventIds) &&
      acknowledgedEventIds.length <= input.deliveries.length &&
      acknowledgedEventIds.every(
        (id) =>
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= MAX_EVENT_ID_CHARS &&
          expectedEventIds.has(id),
      ) &&
      new Set(acknowledgedEventIds).size === acknowledgedEventIds.length;
    if (!valid) {
      dependencies.onError?.(
        new Error("server returned an unsupported decision-feedback acknowledgement"),
      );
    }
    return valid;
  } catch (error) {
    dependencies.onError?.(error);
    return false;
  }
}

export function parseFeedbackCapability(value: unknown): FeedbackCapability | undefined {
  if (!isRecord(value) || !isSupportedProtocolVersion(value.protocolVersion)) return undefined;
  if (value.status === "available") return { status: "available" };
  if (value.status === "unavailable" && value.reason === "organization_unbound") {
    return { status: "unavailable", reason: "organization_unbound" };
  }
  return undefined;
}

export async function fetchFeedbackCapability(
  signal: AbortSignal,
  client: FeedbackClient = getClient(),
): Promise<FeedbackCapability> {
  const result = parseFeedbackCapability(await client.get(STATUS_PATH, { signal }));
  if (!result) throw new Error("server returned an unsupported decision-feedback contract");
  return result;
}
