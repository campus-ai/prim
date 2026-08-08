/**
 * `prim decisions repairs` — inspect and resolve human-gated commit repairs.
 *
 * The backend proposer is heuristic-only. This surface shows the proposed
 * old-SHA -> landed-SHA replacement, its match signals, and every affected
 * decision before an operator explicitly confirms or rejects it. A confirm
 * does not claim the repair was applied: the server first queues a fresh
 * GitHub landing-proof check and applies only if that proof still succeeds.
 *
 * AX contract: STDOUT is the server response as machine-readable JSON;
 * STDERR is a verdict-first human summary. A missing proposal is promoted to
 * RepairProposalNotFoundError so the command can use the decisions not-found
 * exit code; auth, transport, and other server errors remain untouched.
 */

import { type CliClient, HttpError, getClient } from "../client.js";
import { renderIdentifier } from "./recent.js";

export type CommitRepairMatchTier = "exact_patch_body" | "exact_file_set";

export interface CommitRepairProposal {
  _id: string;
  _creationTime: number;
  orgId: string;
  repoFullName: string;
  deadCommitSha: string;
  status: "proposed" | "confirmed" | "verification_failed";
  proposedSha?: string;
  proposedTier?: CommitRepairMatchTier;
  signals: string[];
  rejectedShas: string[];
  lastEvaluatedAt: number;
  nextEvaluateAt?: number;
}

/** The subset of each hydrated decision used by the human renderer. */
export interface RepairDecision {
  _id: string;
  shortId?: string;
  intent: string;
  status: "draft" | "provisional" | "adopted" | "superseded" | "abandoned";
  commitSha?: string;
  branch?: string;
  repoFullName?: string;
}

export interface CommitRepairListItem {
  proposal: CommitRepairProposal;
  decisions: RepairDecision[];
}

export interface RepairsListResult {
  repairs: CommitRepairListItem[];
}

export type RepairResolutionAction = "confirm" | "reject";
export type RepairResolutionOutcome = {
  status: "confirmed" | "rejected" | "already_applied" | "no_op" | "stale";
};

export interface RepairResolutionResult {
  proposalId: string;
  action: RepairResolutionAction;
  outcome: RepairResolutionOutcome;
}

export const REPAIRS_TIMEOUT_MS = 10_000;

export interface RepairsDeps {
  getClient: () => CliClient;
}

const defaultDeps: RepairsDeps = { getClient };

export class RepairProposalNotFoundError extends Error {
  constructor(proposalId: string) {
    super(`Commit repair proposal not found: ${proposalId}`);
    this.name = "RepairProposalNotFoundError";
  }
}

export async function fetchRepairs(deps: RepairsDeps = defaultDeps): Promise<RepairsListResult> {
  const client = deps.getClient();
  return (await client.get("/api/cli/decisions/repairs", {
    signal: AbortSignal.timeout(REPAIRS_TIMEOUT_MS),
  })) as RepairsListResult;
}

export async function resolveRepair(
  proposalId: string,
  expectedProposedSha: string,
  action: RepairResolutionAction,
  deps: RepairsDeps = defaultDeps,
): Promise<RepairResolutionResult> {
  const client = deps.getClient();
  try {
    const outcome = (await client.post(
      "/api/cli/decisions/repairs/resolve",
      { id: proposalId, action, expectedProposedSha },
      { signal: AbortSignal.timeout(REPAIRS_TIMEOUT_MS) },
    )) as RepairResolutionOutcome;
    return { proposalId, action, outcome };
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      throw new RepairProposalNotFoundError(proposalId);
    }
    throw error;
  }
}

function shortSha(sha: string | undefined): string {
  return sha === undefined ? "(missing)" : sha.slice(0, 12);
}

function tierLabel(tier: CommitRepairMatchTier | undefined): string {
  if (tier === "exact_patch_body") {
    return "exact patch body";
  }
  if (tier === "exact_file_set") {
    return "exact file set";
  }
  return "match tier missing";
}

function oneLine(value: string): string {
  return value.replace(/\s+/gu, " ").trim();
}

export function formatRepairsHuman(result: RepairsListResult): string {
  if (result.repairs.length === 0) {
    return "[prim] decision repairs · 0 repairs need action";
  }

  const lines = [
    `[prim] decision repairs · ${String(result.repairs.length)} repair(s) need action`,
  ];
  for (const { proposal, decisions } of result.repairs) {
    lines.push(
      `  ${proposal._id} [${proposal.status}] · ${proposal.repoFullName} · ${shortSha(proposal.deadCommitSha)} -> ${shortSha(proposal.proposedSha)} · ${tierLabel(proposal.proposedTier)}`,
    );
    if (proposal.signals.length > 0) {
      lines.push(`    signals: ${proposal.signals.map(oneLine).join("; ")}`);
    }
    lines.push(`    decisions (${String(decisions.length)}):`);
    for (const decision of decisions) {
      const id = renderIdentifier({ shortId: decision.shortId, id: decision._id });
      lines.push(`      - ${id} [${decision.status}] ${oneLine(decision.intent)}`);
    }
    if (proposal.proposedSha !== undefined) {
      lines.push(
        `    confirm: prim decisions repairs confirm ${proposal._id} ${proposal.proposedSha}`,
        `    reject:  prim decisions repairs reject ${proposal._id} ${proposal.proposedSha}`,
      );
    }
  }
  return lines.join("\n");
}

export function formatRepairsJson(result: RepairsListResult): string {
  return JSON.stringify(result, null, 2);
}

export function formatRepairResolutionHuman(result: RepairResolutionResult): string {
  switch (result.outcome.status) {
    case "confirmed":
      return `[prim] repair ${result.proposalId} confirmed; fresh landing verification queued.`;
    case "rejected":
      return `[prim] repair ${result.proposalId} rejected.`;
    case "already_applied":
      return `[prim] repair ${result.proposalId} was already applied; nothing to change.`;
    case "stale":
      return `[prim] repair ${result.proposalId} changed since review; refresh the repair list before acting.`;
    default:
      return `[prim] repair ${result.proposalId} cannot be ${result.action === "confirm" ? "confirmed" : "rejected"} in its current state; nothing changed.`;
  }
}

export function formatRepairResolutionJson(result: RepairResolutionResult): string {
  return JSON.stringify(result.outcome, null, 2);
}
