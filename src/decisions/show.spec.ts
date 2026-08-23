/**
 * `prim decisions show` — formatter coverage.
 *
 * Tests `formatShowHuman` / `formatShowJson` against the lean
 * DecisionDetail projection the server emits (NOT raw Convex docs):
 * `decision.id`, flat `files: string[]`, named `contexts`, lean
 * `dependsOn` / `dependents` DecisionNode[], and the
 * type/reason/gateVerdict/acknowledgedAt flag summary. Covers a full
 * row with rationale + decided + refs + edges, missing optional fields,
 * a pending confirmation_request flag, and the truncated partial flag.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";

const { mockDaemonRequest } = vi.hoisted(() => ({
  mockDaemonRequest: vi.fn().mockResolvedValue(null),
}));

vi.mock("../daemon/client.js", () => ({
  daemonRequest: mockDaemonRequest,
}));

import {
  DecisionNotFoundError,
  type DecisionShowResult,
  fetchShow,
  formatShowHuman,
  formatShowJson,
} from "./show.js";

const DETAIL: DecisionShowResult = {
  decision: {
    id: "qx7fpmycwabtzke040y7vecnnh8870pg",
    shortId: "230a72aa",
    intent: "Update the AUTH_PROVIDER constant",
    intentKind: "change",
    rationale: "Verification flow",
    decided: ["Mark WorkOS as the verified provider", "Keep the issuer single"],
    alternatives: ["leave as-is", "remove provider"],
    area: "auth",
    producerKind: "claude_code",
    status: "active",
    supersededBy: null,
    confidence: "high",
    reversibility: "high",
    confirmed: false,
    respondedAt: undefined,
    fanOut: 6,
    classifiedAt: Date.UTC(2026, 5, 7, 19, 9, 37),
    authorName: "Taylor",
  },
  files: ["convex/auth-strategy.ts"],
  contexts: [{ id: "k_auth", name: "auth.spec" }],
  flags: [
    {
      type: "confirmation_request",
      file: undefined,
      flaggedAt: Date.UTC(2026, 5, 7, 19, 30, 0),
      acknowledgedAt: undefined,
      gateVerdict: undefined,
      reason: undefined,
    },
  ],
  dependsOn: [],
  dependents: [
    {
      id: "qx70t5ks31z4gbf303ze3v0nb58878wz",
      shortId: "18294ea6",
      intent: "Logout flow",
      area: "auth",
      authorName: "Maya",
      classifiedAt: Date.UTC(2026, 5, 7, 18, 0, 0),
      status: "active",
    },
  ],
  truncated: false,
};

function clientWith(get: CliClient["get"]): CliClient {
  const unexpected = () => {
    throw new Error("unexpected non-GET call");
  };
  return {
    get,
    post: unexpected,
  };
}

describe("fetchShow", () => {
  beforeEach(() => {
    mockDaemonRequest.mockReset();
    mockDaemonRequest.mockResolvedValue(null);
  });

  it("uses the daemon show proxy when available", async () => {
    mockDaemonRequest.mockResolvedValueOnce(DETAIL);
    const get = vi.fn().mockResolvedValue(undefined);

    const result = await fetchShow("dec_230a72aa", { getClient: () => clientWith(get) });

    expect(result).toBe(DETAIL);
    expect(mockDaemonRequest).toHaveBeenCalledWith(
      "decisions_show",
      expect.objectContaining({ path: "/api/cli/decisions/show?id=dec_230a72aa" }),
      { timeoutMs: 250 },
    );
    expect(get).not.toHaveBeenCalled();
  });

  it("falls back to a direct show fetch when the daemon is down", async () => {
    mockDaemonRequest.mockResolvedValueOnce(null);
    const get = vi.fn().mockResolvedValueOnce(DETAIL);

    const result = await fetchShow("dec_230a72aa", { getClient: () => clientWith(get) });

    expect(result).toEqual(DETAIL);
    expect(get).toHaveBeenCalledWith("/api/cli/decisions/show?id=dec_230a72aa", {
      signal: expect.any(AbortSignal),
    });
  });

  it("maps a not-found error to DecisionNotFoundError on the direct path", async () => {
    mockDaemonRequest.mockResolvedValueOnce(null);
    const get = vi.fn().mockRejectedValueOnce(new Error("Decision not found: dec_230a72aa"));

    await expect(
      fetchShow("dec_230a72aa", { getClient: () => clientWith(get) }),
    ).rejects.toBeInstanceOf(DecisionNotFoundError);
  });
});

describe("formatShowHuman", () => {
  it("verdicts the decision with id, intent, status, and area", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("dec_230a72aa");
    expect(out).toContain("Update the AUTH_PROVIDER constant");
    expect(out).toContain("status: active");
    expect(out).toContain("area: auth");
  });

  it("renders alternatives, rationale, and decided points", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("rationale: Verification flow");
    expect(out).toContain("alternatives: leave as-is | remove provider");
    expect(out).toContain("Mark WorkOS as the verified provider");
    expect(out).toContain("Keep the issuer single");
  });

  it("surfaces fan-out from the projection", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("fan-out: 6");
  });

  it("lists referenced files from the flat files array", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("convex/auth-strategy.ts");
  });

  it("renders contexts by name, not id", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("auth.spec");
    expect(out).not.toContain("k_auth");
  });

  it("renders dependents as lean nodes with intent and author", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("dec_18294ea6");
    expect(out).toContain("Logout flow");
    expect(out).toContain("Maya");
  });

  it("notes the pending confirmation request in the flags list", () => {
    const out = formatShowHuman(DETAIL);
    expect(out).toContain("pending confirmation request");
  });

  it("omits the rationale line when not present", () => {
    const noRationale = {
      ...DETAIL,
      decision: { ...DETAIL.decision, rationale: undefined },
    };
    const out = formatShowHuman(noRationale);
    expect(out).not.toContain("rationale:");
  });

  it("renders the raw id when shortId is absent", () => {
    const noShortId = {
      ...DETAIL,
      decision: { ...DETAIL.decision, shortId: undefined },
    };
    const out = formatShowHuman(noShortId);
    expect(out).toContain("qx7fpmycwabtzke040y7vecnnh8870pg");
  });

  it("renders a supersededBy line for a superseded decision", () => {
    const superseded = {
      ...DETAIL,
      decision: {
        ...DETAIL.decision,
        status: "superseded" as const,
        supersededBy: "qxsupersedingdecisionid000000000",
      },
    };
    const out = formatShowHuman(superseded);
    expect(out).toContain("superseded by: qxsupersedingdecisionid000000000");
  });

  it("surfaces respondedAt when the author has responded", () => {
    const responded = {
      ...DETAIL,
      decision: {
        ...DETAIL.decision,
        respondedAt: Date.UTC(2026, 5, 7, 20, 0, 0),
      },
    };
    const out = formatShowHuman(responded);
    expect(out).toContain("responded at:");
  });

  it("renders a pending file_edit flag with its gate verdict", () => {
    const gated = {
      ...DETAIL,
      flags: [
        {
          type: "file_edit",
          file: "convex/auth-strategy.ts",
          flaggedAt: Date.UTC(2026, 5, 7, 19, 30, 0),
          acknowledgedAt: undefined,
          gateVerdict: "invalidated",
          reason: "constant moved to a new module",
        },
      ],
    };
    const out = formatShowHuman(gated);
    expect(out).toContain("pending file_edit (verdict: invalidated)");
    expect(out).toContain("constant moved to a new module");
  });

  it("renders an acknowledged flag distinctly", () => {
    const acknowledged = {
      ...DETAIL,
      flags: [
        {
          type: "file_edit",
          file: "convex/auth-strategy.ts",
          flaggedAt: Date.UTC(2026, 5, 7, 19, 30, 0),
          acknowledgedAt: Date.UTC(2026, 5, 7, 19, 45, 0),
          gateVerdict: "invalidated",
          reason: undefined,
        },
      ],
    };
    const out = formatShowHuman(acknowledged);
    expect(out).toContain("acknowledged file_edit");
  });

  it("notes a partial render when the projection is truncated", () => {
    const out = formatShowHuman({ ...DETAIL, truncated: true });
    expect(out).toContain("partial");
  });

  it("sanitizes all free-text detail fields before terminal rendering", () => {
    const esc = String.fromCharCode(0x1b);
    const unsafe: DecisionShowResult = {
      ...DETAIL,
      decision: {
        ...DETAIL.decision,
        intent: `Update\nAUTH${esc}[2J`,
        rationale: "safe\u202ereason",
        decided: ["one\u200bpoint"],
        alternatives: [`other${esc}]52;c;payload\u0007`],
        area: "au\u200bth",
      },
      files: [`src/auth.ts${esc}[H`],
      contexts: [{ id: "ctx", name: "auth\u202e.spec" }],
      flags: [{ ...DETAIL.flags[0], reason: `flag\nreason${esc}[2J` }],
      dependents: [{ ...DETAIL.dependents[0], authorName: "Ma\u200bya" }],
    };
    const out = formatShowHuman(unsafe);
    expect(out).toContain("Update AUTH[2J");
    expect(out).toContain("safereason");
    expect(out).toContain("onepoint");
    expect(out).not.toContain(esc);
    expect(out).not.toContain("\u200b");
    expect(out).not.toContain("\u202e");
  });
});

describe("formatShowJson", () => {
  it("emits stable JSON with the lean decision shape preserved", () => {
    const parsed = JSON.parse(formatShowJson(DETAIL));
    expect(parsed.decision.id).toBe(DETAIL.decision.id);
    expect(parsed.files).toEqual(["convex/auth-strategy.ts"]);
    expect(parsed.contexts[0].name).toBe("auth.spec");
    expect(parsed.dependents).toHaveLength(1);
    expect(parsed.flags).toHaveLength(1);
  });

  it("does not sanitize the machine-readable projection", () => {
    const unsafe = {
      ...DETAIL,
      decision: { ...DETAIL.decision, intent: "raw\u001b[2J\u202e\u200b" },
    };
    expect(formatShowJson(unsafe)).toBe(JSON.stringify(unsafe, null, 2));
  });
});
