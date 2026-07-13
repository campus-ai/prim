import { type CliClient, getClient } from "../client.js";

export const FEEDBACK_PROTOCOL_VERSION = 1;
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

export type FeedbackDeliveryToken = {
  eventId: string;
  leaseVersion: number;
};

export type FeedbackEvent = FeedbackDeliveryToken & {
  shortId: string;
  intent: string;
  webUrl?: string;
};

export type FeedbackLease = {
  events: FeedbackEvent[];
  hasMore: boolean;
};

export type RenderedFeedback = {
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

function isUnsafeControl(point: number): boolean {
  const c0OrC1 = point <= 0x1f || (point >= 0x7f && point <= 0x9f);
  const bidiControl =
    point === 0x061c ||
    point === 0x200e ||
    point === 0x200f ||
    (point >= 0x202a && point <= 0x202e) ||
    (point >= 0x2066 && point <= 0x2069);
  return c0OrC1 || bidiControl;
}

function replaceIsolatedSurrogates(value: string): string {
  let out = "";
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += value[index] + value[index + 1];
        index += 1;
      } else {
        out += "\ufffd";
      }
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      out += "\ufffd";
    } else {
      out += value[index];
    }
  }
  return out;
}

/** Normalize untrusted display text without changing ordinary Unicode prose. */
export function normalizeFeedbackIntent(value: string): string {
  const safeUnicode = replaceIsolatedSurrogates(value);
  const whitespace = safeUnicode.replace(/\s+/gu, " ");
  const withoutControls = Array.from(whitespace)
    .filter((character) => !isUnsafeControl(character.codePointAt(0) ?? 0))
    .join("")
    .replace(/\s+/gu, " ")
    .trim();
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
    replaceIsolatedSurrogates(value) !== value ||
    Array.from(value).some((character) => isUnsafeControl(character.codePointAt(0) ?? 0))
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

function parseEvent(value: unknown): FeedbackEvent | undefined {
  if (!isRecord(value)) return undefined;
  if (
    typeof value.eventId !== "string" ||
    value.eventId.length === 0 ||
    value.eventId.length > MAX_EVENT_ID_CHARS ||
    Array.from(value.eventId).some((character) => isUnsafeControl(character.codePointAt(0) ?? 0))
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
  return {
    eventId: value.eventId,
    leaseVersion: Number(value.leaseVersion),
    shortId: value.shortId,
    intent,
    ...(webUrl === undefined ? {} : { webUrl }),
  };
}

export function parseFeedbackLease(value: unknown): FeedbackLease | undefined {
  if (!isRecord(value) || value.protocolVersion !== FEEDBACK_PROTOCOL_VERSION) return undefined;
  if (value.status === "empty") {
    return value.hasMore === false ? { events: [], hasMore: false } : undefined;
  }
  if (value.status === "unavailable") {
    return value.reason === "organization_unbound" ? { events: [], hasMore: false } : undefined;
  }
  if (value.status !== "leased" || typeof value.hasMore !== "boolean") return undefined;
  if (
    !Array.isArray(value.events) ||
    value.events.length === 0 ||
    value.events.length > MAX_FEEDBACK_EVENTS
  ) {
    return undefined;
  }
  const events = value.events.map(parseEvent);
  if (events.some((event) => event === undefined)) return undefined;
  const parsedEvents = events as FeedbackEvent[];
  if (new Set(parsedEvents.map((event) => event.eventId)).size !== parsedEvents.length) {
    return undefined;
  }
  return { events: parsedEvents, hasMore: value.hasMore };
}

export function renderFeedback(lease: FeedbackLease): RenderedFeedback | undefined {
  const lines: string[] = [];
  const deliveries: FeedbackDeliveryToken[] = [];
  let pointCount = 0;
  for (const event of lease.events) {
    const line = `[prim] response → created Decision (dec_${event.shortId}): ${event.intent}${event.webUrl ? ` (${event.webUrl})` : ""}`;
    const extra = Array.from(line).length + (lines.length === 0 ? 0 : 1);
    if (pointCount + extra > MAX_FEEDBACK_MESSAGE_CODE_POINTS) break;
    lines.push(line);
    deliveries.push({ eventId: event.eventId, leaseVersion: event.leaseVersion });
    pointCount += extra;
  }
  if (lines.length === 0) return undefined;
  return { systemMessage: lines.join("\n"), deliveries };
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
    workspaceId: string;
    deliveries: FeedbackDeliveryToken[];
    signal: AbortSignal;
  },
  dependencies: { client?: FeedbackClient; onError?: (error: unknown) => void } = {},
): Promise<boolean> {
  if (input.deliveries.length === 0 || input.deliveries.length > MAX_FEEDBACK_EVENTS) return false;
  try {
    const response = await (dependencies.client ?? getClient()).post(
      ACK_PATH,
      {
        protocolVersion: FEEDBACK_PROTOCOL_VERSION,
        workspaceId: input.workspaceId,
        deliveries: input.deliveries,
      },
      { signal: input.signal, quietRefresh: true },
    );
    const acknowledgedEventIds = isRecord(response) ? response.acknowledgedEventIds : undefined;
    const expectedEventIds = new Set(input.deliveries.map((delivery) => delivery.eventId));
    const valid =
      isRecord(response) &&
      response.protocolVersion === FEEDBACK_PROTOCOL_VERSION &&
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
  if (!isRecord(value) || value.protocolVersion !== FEEDBACK_PROTOCOL_VERSION) return undefined;
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
