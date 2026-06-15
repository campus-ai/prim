/**
 * Decision Event Pipeline — Move envelope.
 *
 * Wire and storage shape for a single observed Claude Code hook event.
 * One source of truth across the CLI (this file) and the Convex ingest
 * validator until codegen-from-type or a shared package replaces the
 * dual definition.
 *
 * Fields: identity, capturedAt, sessionId, eventType, payload, env, and a
 * monotonic envelopeVersion the server uses to tolerate older producers
 * during a rollout.
 */

/** Monotonic version of the producer-side envelope schema. */
export const ENVELOPE_VERSION = 1;

export type Move = {
  moveId: string;
  capturedAt: number;
  sessionId: string;
  eventType: string;
  payload: unknown;
  env: {
    cwd: string;
    cliVersion: string;
    osPlatform: NodeJS.Platform;
  };
  envelopeVersion: number;
};
