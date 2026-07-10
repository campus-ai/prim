/**
 * One-shot human feedback for newly created Decisions.
 *
 * Automatic capture creates Decisions asynchronously, so Claude Code drains a
 * small server-side feedback queue and renders each row as a systemMessage.
 * Manual `prim decisions create` reuses the same formatter for its stderr
 * verdict while keeping stdout JSON unchanged.
 */

import { type CliClient, getClient } from "../client.js";
import { renderIdentifier } from "./recent.js";

export interface DecisionFeedbackEvent {
  decisionId: string;
  shortId?: string;
  intent: string;
  createdAt?: number;
}

interface FeedbackDrainResponse {
  feedback?: unknown;
}

export interface FeedbackDrainRequest {
  repoCwd: string;
  scope: "session";
  sessionId?: string;
}

export interface FeedbackDeps {
  getClient: () => CliClient;
}

const defaultDeps: FeedbackDeps = { getClient };

export const DECISION_FEEDBACK_TIMEOUT_MS = 2_500;
export const FEEDBACK_DESCRIPTION_MAX_CHARS = 180;

const WHITESPACE_RE = /\s+/g;
const DELETE_CHAR_CODE = 0x7f;

function stripControlChars(value: string): string {
  return Array.from(value, (char) => {
    const code = char.charCodeAt(0);
    return code < 0x20 || code === DELETE_CHAR_CODE ? " " : char;
  }).join("");
}

export function cleanFeedbackDescription(value: string): string {
  const cleaned = stripControlChars(value).replace(WHITESPACE_RE, " ").trim();
  if (cleaned.length <= FEEDBACK_DESCRIPTION_MAX_CHARS) {
    return cleaned;
  }
  return `${cleaned.slice(0, FEEDBACK_DESCRIPTION_MAX_CHARS - 1).trimEnd()}…`;
}

export function formatDecisionCreatedFeedback(event: DecisionFeedbackEvent): string {
  const id = renderIdentifier({ id: event.decisionId, shortId: event.shortId });
  const description = cleanFeedbackDescription(event.intent) || "Decision recorded";
  return `[prim] response → created Decision (${id}): ${description}`;
}

export function formatDecisionFeedbackSystemMessage(
  events: DecisionFeedbackEvent[],
): string | undefined {
  const lines = events.map(formatDecisionCreatedFeedback).filter((line) => line.length > 0);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function normalizeDecisionFeedbackEvent(value: unknown): DecisionFeedbackEvent | undefined {
  if (typeof value !== "object" || value === null) {
    return;
  }
  const row = value as Record<string, unknown>;
  if (typeof row.decisionId !== "string" || typeof row.intent !== "string") {
    return;
  }
  return {
    decisionId: row.decisionId,
    shortId: typeof row.shortId === "string" ? row.shortId : undefined,
    intent: row.intent,
    createdAt: typeof row.createdAt === "number" ? row.createdAt : undefined,
  };
}

export async function drainDecisionFeedback(
  request: FeedbackDrainRequest,
  deps: FeedbackDeps = defaultDeps,
): Promise<DecisionFeedbackEvent[]> {
  const client = deps.getClient();
  const result = (await client.post(
    "/api/cli/decisions/feedback/drain",
    {
      consumer: "claude_code",
      repoCwd: request.repoCwd,
      scope: request.scope,
      ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    },
    {
      signal: AbortSignal.timeout(DECISION_FEEDBACK_TIMEOUT_MS),
    },
  )) as FeedbackDrainResponse;
  return Array.isArray(result.feedback)
    ? result.feedback.flatMap((row) => {
        const event = normalizeDecisionFeedbackEvent(row);
        return event ? [event] : [];
      })
    : [];
}
