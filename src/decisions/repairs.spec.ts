/** `prim decisions repairs` client, wire, and formatter coverage. */

import { describe, expect, it, vi } from "vitest";
import { type CliClient, HttpError } from "../client.js";
import {
  RepairProposalNotFoundError,
  type RepairResolutionResult,
  type RepairsDeps,
  type RepairsListResult,
  fetchRepairs,
  formatRepairResolutionHuman,
  formatRepairResolutionJson,
  formatRepairsHuman,
  formatRepairsJson,
  resolveRepair,
} from "./repairs.js";

const PROPOSAL_ID = "jd7abc123repairproposal";
const DEAD_SHA = "a".repeat(40);
const PROPOSED_SHA = "b".repeat(40);

const LIST_RESULT: RepairsListResult = {
  repairs: [
    {
      proposal: {
        _id: PROPOSAL_ID,
        _creationTime: 1_700_000_000_000,
        orgId: "org-1",
        repoFullName: "campus-ai/prim",
        deadCommitSha: DEAD_SHA,
        status: "proposed",
        proposedSha: PROPOSED_SHA,
        proposedTier: "exact_patch_body",
        signals: ["identical patch body", "3 changed files\nmatched"],
        rejectedShas: [],
        lastEvaluatedAt: 1_700_000_100_000,
      },
      decisions: [
        {
          _id: "decision-full-id",
          shortId: "230a72aa",
          intent: "Keep the repair\nreviewable",
          status: "provisional",
          commitSha: DEAD_SHA,
          repoFullName: "campus-ai/prim",
        },
      ],
    },
  ],
};

function clientWith(overrides: Partial<CliClient>): CliClient {
  const unexpected = () => {
    throw new Error("unexpected client call");
  };
  return {
    get: overrides.get ?? unexpected,
    post: overrides.post ?? unexpected,
  };
}

function deps(client: CliClient): RepairsDeps {
  return { getClient: () => client };
}

describe("repair client", () => {
  it("gets the proposed repair list from the dedicated endpoint", async () => {
    const get = vi.fn().mockResolvedValue(LIST_RESULT);

    const result = await fetchRepairs(deps(clientWith({ get })));

    expect(result).toEqual(LIST_RESULT);
    expect(get).toHaveBeenCalledWith(
      "/api/cli/decisions/repairs",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it.each(["confirm", "reject"] as const)(
    "posts an explicit %s resolution body",
    async (action) => {
      const post = vi.fn().mockResolvedValue({ status: `${action}ed` });

      const result = await resolveRepair(
        PROPOSAL_ID,
        PROPOSED_SHA,
        action,
        deps(clientWith({ post })),
      );

      expect(post).toHaveBeenCalledWith(
        "/api/cli/decisions/repairs/resolve",
        { id: PROPOSAL_ID, action, expectedProposedSha: PROPOSED_SHA },
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
      expect(result).toEqual({
        proposalId: PROPOSAL_ID,
        action,
        outcome: { status: `${action}ed` },
      });
    },
  );

  it("maps a 404 to the command-level not-found error", async () => {
    const post = vi.fn().mockRejectedValue(new HttpError(404, "Repair proposal not found"));

    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "confirm", deps(clientWith({ post }))),
    ).rejects.toEqual(new RepairProposalNotFoundError(PROPOSAL_ID));
  });

  it("leaves auth and transport failures untouched", async () => {
    const error = new HttpError(403, "CLI token is not bound to an organization");
    const post = vi.fn().mockRejectedValue(error);

    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "reject", deps(clientWith({ post }))),
    ).rejects.toBe(error);
  });
});

describe("repair list formatters", () => {
  it("renders the evidence, affected decision, and explicit resolution verbs", () => {
    const human = formatRepairsHuman(LIST_RESULT);

    expect(human).toContain("1 repair(s) need action");
    expect(human).toContain(PROPOSAL_ID);
    expect(human).toContain("campus-ai/prim");
    expect(human).toContain(`${DEAD_SHA.slice(0, 12)} -> ${PROPOSED_SHA.slice(0, 12)}`);
    expect(human).toContain("exact patch body");
    expect(human).toContain("identical patch body; 3 changed files matched");
    expect(human).toContain("dec_230a72aa [provisional] Keep the repair reviewable");
    expect(human).toContain(`prim decisions repairs confirm ${PROPOSAL_ID} ${PROPOSED_SHA}`);
    expect(human).toContain(`prim decisions repairs reject ${PROPOSAL_ID} ${PROPOSED_SHA}`);
  });

  it("renders an honest empty-list verdict", () => {
    expect(formatRepairsHuman({ repairs: [] })).toBe(
      "[prim] decision repairs · 0 repairs need action",
    );
  });

  it("emits the server list response verbatim as JSON", () => {
    expect(formatRepairsJson(LIST_RESULT)).toBe(JSON.stringify(LIST_RESULT, null, 2));
  });
});

describe("repair resolution formatters", () => {
  it("says confirmation queued fresh proof rather than claiming application", () => {
    const result: RepairResolutionResult = {
      proposalId: PROPOSAL_ID,
      action: "confirm",
      outcome: { status: "confirmed" },
    };

    const human = formatRepairResolutionHuman(result);
    expect(human).toContain("confirmed");
    expect(human).toContain("fresh landing verification queued");
    expect(human).not.toContain("applied");
  });

  it("distinguishes rejection, an already-applied receipt, and a raced no-op", () => {
    expect(
      formatRepairResolutionHuman({
        proposalId: PROPOSAL_ID,
        action: "reject",
        outcome: { status: "rejected" },
      }),
    ).toContain("rejected");
    expect(
      formatRepairResolutionHuman({
        proposalId: PROPOSAL_ID,
        action: "confirm",
        outcome: { status: "already_applied" },
      }),
    ).toContain("already applied");
    expect(
      formatRepairResolutionHuman({
        proposalId: PROPOSAL_ID,
        action: "reject",
        outcome: { status: "no_op" },
      }),
    ).toContain("nothing changed");
  });

  it("reports a stale reviewed SHA as requiring a refreshed list", () => {
    expect(
      formatRepairResolutionHuman({
        proposalId: PROPOSAL_ID,
        action: "confirm",
        outcome: { status: "stale" },
      }),
    ).toContain("changed since review");
  });

  it("emits only the server resolution outcome on stdout", () => {
    const result: RepairResolutionResult = {
      proposalId: PROPOSAL_ID,
      action: "reject",
      outcome: { status: "rejected" },
    };
    expect(JSON.parse(formatRepairResolutionJson(result))).toEqual({ status: "rejected" });
  });
});
