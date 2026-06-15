/**
 * Decision Event Pipeline — Move envelope.
 *
 * Wire and storage shape for a single observed Claude Code hook event.
 * One source of truth across the CLI (this file) and the Convex ingest
 * validator until codegen-from-type or a shared package replaces the
 * dual definition.
 *
 * The minimum-required field set: identity, capturedAt, sessionId,
 * eventType, payload, env. Producer-identity and schema-version fields
 * are added when envelope versioning lands.
 */
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
};
