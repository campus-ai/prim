/** `prim decisions repairs` client, wire, safety, and formatter coverage. */

import { describe, expect, it, vi } from "vitest";
import { type CliClient, HttpError } from "../client.js";
import {
  type CommitRepairListItem,
  RepairAuthorizationError,
  RepairEndpointVersionError,
  RepairListContractError,
  RepairProposalNotFoundError,
  RepairResolutionInputError,
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
const REVIEW_TOKEN = "c".repeat(64);

function repairItem(
  overrides: {
    proposalId?: string;
    status?: CommitRepairListItem["proposal"]["status"];
    decisions?: CommitRepairListItem["decisions"];
    affectedDecisionCount?: number | null;
    decisionsTruncated?: boolean;
    reviewToken?: string | null;
  } = {},
): CommitRepairListItem {
  const decisions = overrides.decisions ?? [
    {
      _id: "decision-full-id",
      shortId: "230a72aa",
      intent: "Keep the repair reviewable",
      status: "provisional",
      intentTruncated: false,
    },
  ];
  return {
    proposal: {
      _id: overrides.proposalId ?? PROPOSAL_ID,
      repoFullName: "campus-ai/prim",
      deadCommitSha: DEAD_SHA,
      status: overrides.status ?? "proposed",
      proposedSha: PROPOSED_SHA,
      proposedTier: "exact_patch_body",
      signals: ["identical patch body", "3 changed files matched"],
      lastEvaluatedAt: 1_700_000_100_000,
    },
    decisions,
    affectedDecisionCount: Object.hasOwn(overrides, "affectedDecisionCount")
      ? (overrides.affectedDecisionCount ?? null)
      : decisions.length,
    decisionsTruncated: overrides.decisionsTruncated ?? false,
    reviewToken: Object.hasOwn(overrides, "reviewToken")
      ? (overrides.reviewToken ?? null)
      : overrides.decisionsTruncated === true
        ? null
        : REVIEW_TOKEN,
  };
}

function page(
  repairs: CommitRepairListItem[] = [repairItem()],
  options: { isDone?: boolean; nextCursor?: string | null } = {},
): unknown {
  const isDone = options.isDone ?? true;
  return {
    repairs,
    isDone,
    nextCursor: options.nextCursor ?? (isDone ? null : "next-cursor"),
    truncated: !isDone,
  };
}

function completeResult(repairs: CommitRepairListItem[] = [repairItem()]): RepairsListResult {
  return { repairs, isDone: true, nextCursor: null, truncated: false };
}

function clientWith(overrides: Partial<CliClient>): CliClient {
  const unexpected = () => {
    throw new Error("unexpected client call");
  };
  return {
    get: overrides.get ?? unexpected,
    post: overrides.post ?? unexpected,
  };
}

function deps(client: CliClient, maxPages?: number): RepairsDeps {
  return { getClient: () => client, maxPages };
}

describe("repair list client", () => {
  it("validates and returns an exhaustive single-page scan", async () => {
    const get = vi.fn().mockResolvedValue(page());

    const result = await fetchRepairs(deps(clientWith({ get })));

    expect(result).toMatchObject(completeResult());
    expect(get).toHaveBeenCalledWith(
      "/api/cli/decisions/repairs",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
  });

  it("follows encoded cursors through empty intermediate pages before returning anything", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(page([], { isDone: false, nextCursor: "opaque /+=?" }))
      .mockResolvedValueOnce(page([], { isDone: false, nextCursor: "second:cursor" }))
      .mockResolvedValueOnce(page([repairItem()]));

    const result = await fetchRepairs(deps(clientWith({ get })));

    expect(result.repairs).toHaveLength(1);
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      "/api/cli/decisions/repairs",
      "/api/cli/decisions/repairs?cursor=opaque+%2F%2B%3D%3F",
      "/api/cli/decisions/repairs?cursor=second%3Acursor",
    ]);
    expect(get.mock.calls[0][1]?.signal).not.toBe(get.mock.calls[1][1]?.signal);
    expect(get.mock.calls[1][1]?.signal).not.toBe(get.mock.calls[2][1]?.signal);
    expect(result).toMatchObject({ isDone: true, nextCursor: null, truncated: false });
  });

  it("preserves server order while aggregating multiple non-empty pages", async () => {
    const first = repairItem({ proposalId: "first-proposal" });
    const second = repairItem({ proposalId: "second-proposal" });
    const get = vi
      .fn()
      .mockResolvedValueOnce(page([first], { isDone: false, nextCursor: "second" }))
      .mockResolvedValueOnce(page([second]));

    const result = await fetchRepairs(deps(clientWith({ get })));

    expect(result.repairs.map(({ proposal }) => proposal._id)).toEqual([
      "first-proposal",
      "second-proposal",
    ]);
  });

  it("fails closed on a repeated or non-advancing cursor", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(page([], { isDone: false, nextCursor: "same" }))
      .mockResolvedValueOnce(page([], { isDone: false, nextCursor: "same" }));

    await expect(fetchRepairs(deps(clientWith({ get })))).rejects.toThrow(
      /repeated or non-advancing cursor/u,
    );
  });

  it("fails closed at the hard page cap without returning a partial aggregate", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(page([], { isDone: false, nextCursor: "one" }))
      .mockResolvedValueOnce(page([], { isDone: false, nextCursor: "two" }));

    await expect(fetchRepairs(deps(clientWith({ get }), 2))).rejects.toThrow(
      /did not finish within 2 page/u,
    );
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("rejects duplicate proposal IDs across pages", async () => {
    const get = vi
      .fn()
      .mockResolvedValueOnce(page([repairItem()], { isDone: false, nextCursor: "two" }))
      .mockResolvedValueOnce(page([repairItem()]));

    await expect(fetchRepairs(deps(clientWith({ get })))).rejects.toThrow(/repeats a proposal/u);
  });

  it.each([
    ["missing completion field", { repairs: [], isDone: true, nextCursor: null }],
    [
      "inconsistent completion flags",
      { repairs: [], isDone: true, nextCursor: null, truncated: true },
    ],
    [
      "unexpected least-privilege field",
      page([
        {
          ...repairItem(),
          proposal: { ...repairItem().proposal, orgId: "secret-org" },
        } as CommitRepairListItem,
      ]),
    ],
    ["mismatched complete count", page([repairItem({ affectedDecisionCount: 2 })])],
    [
      "token on a truncated review",
      page([
        repairItem({
          affectedDecisionCount: 26,
          decisionsTruncated: true,
          reviewToken: REVIEW_TOKEN,
        }),
      ]),
    ],
    ["invalid review token", page([repairItem({ reviewToken: `${"c".repeat(63)}z` })])],
    [
      "review token without a proposed SHA",
      (() => {
        const item = repairItem();
        Reflect.deleteProperty(item.proposal, "proposedSha");
        return page([item]);
      })(),
    ],
    [
      "review token without a proposed tier",
      (() => {
        const item = repairItem();
        Reflect.deleteProperty(item.proposal, "proposedTier");
        return page([item]);
      })(),
    ],
    [
      "review token for a no-op replacement",
      (() => {
        const item = repairItem();
        item.proposal.proposedSha = item.proposal.deadCommitSha;
        return page([item]);
      })(),
    ],
    [
      "unknown decision status",
      page([
        repairItem({
          decisions: [
            {
              _id: "decision-full-id",
              intent: "unsafe status",
              status: "adopted" as CommitRepairListItem["decisions"][number]["status"],
              intentTruncated: false,
            },
          ],
        }),
      ]),
    ],
  ])("rejects a malformed %s response", async (_case, response) => {
    await expect(
      fetchRepairs(deps(clientWith({ get: vi.fn().mockResolvedValue(response) }))),
    ).rejects.toBeInstanceOf(RepairListContractError);
  });

  it("maps authorization failures to neutral membership-and-repository guidance", async () => {
    const get = vi.fn().mockRejectedValue(new HttpError(403, "raw membership detail"));
    const error = new RepairAuthorizationError();
    await expect(fetchRepairs(deps(clientWith({ get })))).rejects.toEqual(error);
    expect(error.message).toContain("active organization membership");
    expect(error.message).toContain("current repository authorization");
  });

  it("accepts a null review token on a complete projection as confirmation-suppressed", async () => {
    const item = repairItem({ reviewToken: null });
    const result = await fetchRepairs(
      deps(clientWith({ get: vi.fn().mockResolvedValue(page([item])) })),
    );
    expect(result.repairs[0].reviewToken).toBeNull();
    expect(formatRepairsHuman(result)).not.toContain(`confirm ${PROPOSAL_ID}`);
    expect(formatRepairsHuman(result)).toContain("confirmation is currently unavailable");
  });

  it("reports a missing list endpoint as probable version skew", async () => {
    const get = vi.fn().mockRejectedValue(new HttpError(404, "Not found"));
    await expect(fetchRepairs(deps(clientWith({ get })))).rejects.toEqual(
      new RepairEndpointVersionError(),
    );
  });
});

describe("repair resolution client", () => {
  it("normalizes both reviewed values and posts the exact confirmation CAS body", async () => {
    const post = vi.fn().mockResolvedValue({ status: "confirmed" });

    const result = await resolveRepair(
      PROPOSAL_ID,
      PROPOSED_SHA.toUpperCase(),
      "confirm",
      REVIEW_TOKEN.toUpperCase(),
      deps(clientWith({ post })),
    );

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/repairs/resolve",
      {
        id: PROPOSAL_ID,
        action: "confirm_reviewed_v2",
        expectedProposedSha: PROPOSED_SHA,
        expectedReviewToken: REVIEW_TOKEN,
      },
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(post).toHaveBeenCalledOnce();
    expect(post).not.toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: "confirm" }),
      expect.any(Object),
    );
    expect(result.outcome).toEqual({ status: "confirmed" });
  });

  it("posts a rejection CAS without requiring a complete decision review", async () => {
    const get = vi.fn();
    const post = vi.fn().mockResolvedValue({ status: "rejected" });

    await resolveRepair(
      PROPOSAL_ID,
      PROPOSED_SHA.toUpperCase(),
      "reject",
      undefined,
      deps(clientWith({ get, post })),
    );

    expect(get).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/repairs/resolve",
      { id: PROPOSAL_ID, action: "reject", expectedProposedSha: PROPOSED_SHA },
      expect.any(Object),
    );
  });

  it.each([undefined, "short", `${"d".repeat(63)}z`])(
    "refuses a missing or malformed review token without posting",
    async (reviewToken) => {
      const post = vi.fn();
      await expect(
        resolveRepair(
          PROPOSAL_ID,
          PROPOSED_SHA,
          "confirm",
          reviewToken,
          deps(clientWith({ post })),
        ),
      ).rejects.toBeInstanceOf(RepairResolutionInputError);
      expect(post).not.toHaveBeenCalled();
    },
  );

  it("validates resolution input before any network call", async () => {
    const get = vi.fn();
    const post = vi.fn();
    await expect(
      resolveRepair(PROPOSAL_ID, "short", "confirm", REVIEW_TOKEN, deps(clientWith({ get, post }))),
    ).rejects.toBeInstanceOf(RepairResolutionInputError);
    expect(get).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("maps only the exact proposal 404 to not-found", async () => {
    const post = vi.fn().mockRejectedValue(new HttpError(404, "Repair proposal not found"));
    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "reject", undefined, deps(clientWith({ post }))),
    ).rejects.toEqual(new RepairProposalNotFoundError(PROPOSAL_ID));
  });

  it("reports a generic resolve 404 as probable version skew", async () => {
    const post = vi.fn().mockRejectedValue(new HttpError(404, "Not found"));
    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "reject", undefined, deps(clientWith({ post }))),
    ).rejects.toEqual(new RepairEndpointVersionError());
  });

  it("reports the exact old-handler confirmation 400 as version skew without retrying legacy confirm", async () => {
    const message = "Body requires id, action (confirm or reject), and expectedProposedSha";
    const post = vi.fn().mockRejectedValue(new HttpError(400, message, { error: message }));

    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "confirm", REVIEW_TOKEN, deps(clientWith({ post }))),
    ).rejects.toEqual(new RepairEndpointVersionError());
    expect(post).toHaveBeenCalledOnce();
    expect(post).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ action: "confirm_reviewed_v2" }),
      expect.any(Object),
    );
  });

  it("maps the exact protocol-required 400 to the same upgrade guidance", async () => {
    const message =
      "Reviewed confirmation protocol required; legacy action confirm is not supported";
    const post = vi.fn().mockRejectedValue(new HttpError(400, message, { error: message }));

    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "confirm", REVIEW_TOKEN, deps(clientWith({ post }))),
    ).rejects.toEqual(new RepairEndpointVersionError());
    expect(post).toHaveBeenCalledOnce();
  });

  it("leaves the malformed-v2 token 400 loud and untouched", async () => {
    const message = "Confirm requires expectedReviewToken as 64 lowercase hex characters";
    const error = new HttpError(400, message, { error: message });
    const post = vi.fn().mockRejectedValue(error);

    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "confirm", REVIEW_TOKEN, deps(clientWith({ post }))),
    ).rejects.toBe(error);
    expect(post).toHaveBeenCalledOnce();
  });

  it("maps resolve membership failures", async () => {
    const post = vi.fn().mockRejectedValue(new HttpError(403, "raw membership detail"));
    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "reject", undefined, deps(clientWith({ post }))),
    ).rejects.toEqual(new RepairAuthorizationError());
  });

  it("folds the server's structured 409 into review_too_large", async () => {
    const post = vi
      .fn()
      .mockRejectedValue(new HttpError(409, "HTTP 409", { status: "review_too_large" }));
    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "confirm", REVIEW_TOKEN, deps(clientWith({ post }))),
    ).resolves.toMatchObject({ outcome: { status: "review_too_large" } });
  });

  it("distinguishes a stale reviewed decision set from an oversized review", async () => {
    const post = vi
      .fn()
      .mockRejectedValue(new HttpError(409, "HTTP 409", { status: "stale_review" }));
    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "confirm", REVIEW_TOKEN, deps(clientWith({ post }))),
    ).resolves.toMatchObject({ outcome: { status: "stale_review" } });
  });

  it("fails closed on an unrecognized 409 body", async () => {
    const post = vi.fn().mockRejectedValue(new HttpError(409, "HTTP 409"));
    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "confirm", REVIEW_TOKEN, deps(clientWith({ post }))),
    ).rejects.toBeInstanceOf(RepairListContractError);
  });

  it("validates backoff and all other resolution response shapes", async () => {
    const valid = vi.fn().mockResolvedValue({ status: "backoff", retryAt: 1_800_000_000_000 });
    await expect(
      resolveRepair(
        PROPOSAL_ID,
        PROPOSED_SHA,
        "confirm",
        REVIEW_TOKEN,
        deps(clientWith({ post: valid })),
      ),
    ).resolves.toMatchObject({ outcome: { status: "backoff", retryAt: 1_800_000_000_000 } });

    const invalid = vi.fn().mockResolvedValue({ status: "backoff" });
    await expect(
      resolveRepair(
        PROPOSAL_ID,
        PROPOSED_SHA,
        "confirm",
        REVIEW_TOKEN,
        deps(clientWith({ post: invalid })),
      ),
    ).rejects.toBeInstanceOf(RepairListContractError);
  });

  it.each([
    ["confirm", { status: "confirmed" }],
    ["reject", { status: "rejected" }],
    ["confirm", { status: "already_applied" }],
    ["confirm", { status: "disabled" }],
    ["confirm", { status: "no_op" }],
    ["reject", { status: "stale" }],
    ["confirm", { status: "backoff", retryAt: 1_800_000_000_000 }],
  ] as const)("accepts the exact $0 200 outcome $1.status", async (action, outcome) => {
    const post = vi.fn().mockResolvedValue(outcome);
    await expect(
      resolveRepair(
        PROPOSAL_ID,
        PROPOSED_SHA,
        action,
        action === "confirm" ? REVIEW_TOKEN : undefined,
        deps(clientWith({ post })),
      ),
    ).resolves.toMatchObject({ outcome });
  });

  it.each([
    { status: "confirmed" },
    { status: "disabled" },
    { status: "backoff", retryAt: 1_800_000_000_000 },
  ])("fails closed on impossible reject + $status", async (outcome) => {
    const post = vi.fn().mockResolvedValue(outcome);
    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "reject", undefined, deps(clientWith({ post }))),
    ).rejects.toBeInstanceOf(RepairListContractError);
  });

  it.each(["review_too_large", "stale_review"])(
    "fails closed on impossible reject + 409 %s",
    async (status) => {
      const post = vi.fn().mockRejectedValue(new HttpError(409, "HTTP 409", { status }));
      await expect(
        resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "reject", undefined, deps(clientWith({ post }))),
      ).rejects.toBeInstanceOf(RepairListContractError);
    },
  );

  it("fails loudly on an unknown 200 outcome", async () => {
    const post = vi.fn().mockResolvedValue({ status: "applied" });
    await expect(
      resolveRepair(PROPOSAL_ID, PROPOSED_SHA, "reject", undefined, deps(clientWith({ post }))),
    ).rejects.toBeInstanceOf(RepairListContractError);
  });
});

describe("repair list formatters", () => {
  it("renders complete evidence, count truth, and explicit resolution verbs", () => {
    const human = formatRepairsHuman(completeResult());

    expect(human).toContain("1 review-visible proposal(s)");
    expect(human).toContain("complete paginated scan");
    expect(human).toContain(PROPOSAL_ID);
    expect(human).toContain("awaiting operator review");
    expect(human).toContain(`${DEAD_SHA.slice(0, 12)} -> ${PROPOSED_SHA.slice(0, 12)}`);
    expect(human).toContain("decisions (1 affected; complete)");
    expect(human).toContain("dec_230a72aa [provisional] Keep the repair reviewable");
    expect(human).toContain(
      `prim decisions repairs confirm ${PROPOSAL_ID} ${PROPOSED_SHA} --review-token ${REVIEW_TOKEN}`,
    );
    expect(human).toContain(`prim decisions repairs reject ${PROPOSAL_ID} ${PROPOSED_SHA}`);
  });

  it("surfaces intent truncation and strips terminal control-byte injection", () => {
    const ESC = String.fromCharCode(0x1b);
    const BEL = String.fromCharCode(0x07);
    const item = repairItem({
      decisions: [
        {
          _id: "decision-full-id",
          intent: `Keep${ESC}]52;c;payload${BEL}\nreviewing`,
          status: "provisional",
          intentTruncated: true,
        },
      ],
    });
    item.proposal._id = `proposal${ESC}id`;
    item.proposal.signals = [`signal${BEL}\ncontinued`];
    item.decisions[0]._id = `decision${ESC}id`;

    const human = formatRepairsHuman(completeResult([item]));

    expect(human).toContain("[intent truncated]");
    expect(human).not.toContain(ESC);
    expect(human).not.toContain(BEL);
    expect(human).not.toContain("\nreviewing");
    expect(human).toContain("signal continued");
    expect(human).toContain("proposalid");
  });

  it("shell-quotes the proposal ID in every rendered action recipe", () => {
    const item = repairItem({ proposalId: "proposal id" });
    const human = formatRepairsHuman(completeResult([item]));
    expect(human).toContain(`confirm 'proposal id' ${PROPOSED_SHA} --review-token ${REVIEW_TOKEN}`);
    expect(human).toContain(`reject 'proposal id' ${PROPOSED_SHA}`);
  });

  it("suppresses initial confirmation for incomplete/empty items and labels confirmed retry", () => {
    const incomplete = repairItem({
      affectedDecisionCount: null,
      decisionsTruncated: true,
      reviewToken: null,
    });
    const empty = repairItem({ decisions: [], affectedDecisionCount: 0, proposalId: "empty-id" });
    const confirmed = repairItem({ status: "confirmed", proposalId: "confirmed-id" });
    const human = formatRepairsHuman(completeResult([incomplete, empty, confirmed]));

    expect(human).toContain("total unknown; confirmation disabled");
    expect(human).toContain("0 affected; confirmation disabled");
    expect(human).toContain("already confirmed");
    expect(human).not.toContain(`confirm ${incomplete.proposal._id}`);
    expect(human).not.toContain("confirm empty-id");
    expect(human).toContain("guarded application retry");
    expect(human).toContain(
      `guarded retry confirmation: prim decisions repairs confirm confirmed-id ${PROPOSED_SHA} --review-token ${REVIEW_TOKEN}`,
    );
    expect(human).toContain(`reject ${incomplete.proposal._id}`);
  });

  it("labels a verification failure as an explicit fresh-proof retry", () => {
    const item = repairItem({ status: "verification_failed" });
    const human = formatRepairsHuman(completeResult([item]));
    expect(human).toContain("prior verification failed");
    expect(human).toContain("retry verification: prim decisions repairs confirm");
  });

  it("distinguishes proposal evaluation timing from application retry backoff", () => {
    const item = repairItem();
    item.proposal.nextEvaluateAt = 1_750_000_000_000;
    const listHuman = formatRepairsHuman(completeResult([item]));
    const backoffHuman = formatRepairResolutionHuman({
      proposalId: PROPOSAL_ID,
      action: "confirm",
      outcome: { status: "backoff", retryAt: 1_800_000_000_000 },
    });
    expect(listHuman).toContain("next proposal evaluation:");
    expect(listHuman).not.toContain("application retry backoff");
    expect(backoffHuman).toContain("application retry backoff");
    expect(backoffHuman).not.toContain("proposal evaluation");
  });

  it("renders an honest empty-list verdict and exhaustive JSON envelope", () => {
    const result = completeResult([]);
    expect(formatRepairsHuman(result)).toBe(
      "[prim] decision repairs · 0 review-visible proposals · complete paginated scan",
    );
    expect(formatRepairsJson(result)).toBe(JSON.stringify(result, null, 2));
  });

  it("keeps the explicit review token in machine-readable list output", () => {
    const parsed = JSON.parse(formatRepairsJson(completeResult())) as {
      repairs: Array<{ reviewToken: string | null }>;
    };
    expect(parsed.repairs[0].reviewToken).toBe(REVIEW_TOKEN);
  });
});

describe("repair resolution formatters", () => {
  it("says confirmation queued fresh proof without claiming synchronous application", () => {
    const result: RepairResolutionResult = {
      proposalId: PROPOSAL_ID,
      action: "confirm",
      outcome: { status: "confirmed" },
    };
    const human = formatRepairResolutionHuman(result);
    expect(human).toContain("fresh landing verification queued");
    expect(human).not.toContain("applied");
  });

  it.each([
    ["disabled", "application is disabled"],
    ["review_too_large", "exceeds the safe bound"],
    ["stale_review", "re-list and review"],
    ["stale", "refresh the repair list"],
    ["no_op", "nothing changed"],
  ] as const)("truthfully renders %s", (status, expected) => {
    expect(
      formatRepairResolutionHuman({
        proposalId: PROPOSAL_ID,
        action: "confirm",
        outcome: { status },
      }),
    ).toContain(expected);
  });

  it("renders the exact backoff retry time", () => {
    expect(
      formatRepairResolutionHuman({
        proposalId: PROPOSAL_ID,
        action: "confirm",
        outcome: { status: "backoff", retryAt: 1_800_000_000_000 },
      }),
    ).toContain("1800000000000");
  });

  it("emits only the validated server resolution outcome on stdout", () => {
    const result: RepairResolutionResult = {
      proposalId: PROPOSAL_ID,
      action: "reject",
      outcome: { status: "rejected" },
    };
    expect(JSON.parse(formatRepairResolutionJson(result))).toEqual({ status: "rejected" });
  });
});
