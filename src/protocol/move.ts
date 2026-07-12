/**
 * Decision Event Pipeline — Move envelope.
 *
 * Wire and storage shape for a single observed coding-agent hook event.
 * One source of truth across the CLI (this file) and the Convex ingest
 * validator until codegen-from-type or a shared package replaces the
 * dual definition.
 *
 * Fields: identity, capturedAt, sessionId, eventType, payload, env, and a
 * monotonic envelopeVersion the server uses to tolerate older producers
 * during a rollout.
 */

/** The byte-compatible envelope emitted before worktree provenance existed. */
export const LEGACY_ENVELOPE_VERSION = 1 as const;

/** The first envelope that carries explicit agent and worktree provenance. */
export const AGENT_ENVELOPE_VERSION = 2 as const;

/**
 * Legacy alias retained for callers that intentionally emit V1, notably the
 * agent-agnostic git.commit hook.
 */
export const ENVELOPE_VERSION = LEGACY_ENVELOPE_VERSION;

export type AgentProducer = "claude_code" | "codex" | "hermes";

export type MoveEnvironment = {
  cwd: string;
  cliVersion: string;
  osPlatform: NodeJS.Platform;
};

type MoveFields = {
  moveId: string;
  capturedAt: number;
  sessionId: string;
  eventType: string;
  payload: unknown;
};

/**
 * Original wire shape. producer remains optional because released V1 Codex
 * and Hermes hooks already stamp it while Claude and git.commit omit it.
 */
export type MoveV1 = MoveFields & {
  env: MoveEnvironment;
  envelopeVersion: typeof LEGACY_ENVELOPE_VERSION;
  /**
   * Which coding agent produced this move. Stamped from the hook's
   * `--agent` flag; omitted for Claude Code (the backend treats an absent
   * value as "claude_code"), set to "codex" / "hermes" for those sessions.
   */
  producer?: AgentProducer;
};

/**
 * Agent event with explicit provenance. workspaceId is deliberately nested
 * under env so an older server whose top-level validator is closed can still
 * accept the additive envelope during a server-first rollout.
 */
export type AgentMoveV2 = MoveFields & {
  env: MoveEnvironment & { workspaceId: string };
  envelopeVersion: typeof AGENT_ENVELOPE_VERSION;
  producer: AgentProducer;
};

export type Move = MoveV1 | AgentMoveV2;

/**
 * Upgrade a V1 agent move without mutating it. Callers must only invoke this
 * after obtaining a valid workspace ID; otherwise they should journal the V1
 * move unchanged so capture remains fail-open.
 */
export function withAgentProvenance(
  move: MoveV1,
  producer: AgentProducer,
  workspaceId: string,
): AgentMoveV2 {
  return {
    ...move,
    env: { ...move.env, workspaceId },
    envelopeVersion: AGENT_ENVELOPE_VERSION,
    producer,
  };
}
