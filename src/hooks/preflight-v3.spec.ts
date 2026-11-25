import { describe, expect, it } from "vitest";
import { type PreflightResponse, coverageNote } from "./preflight-v3.js";

const NOTE =
  "[primitive] Decision coverage is incomplete; some candidates or evidence were not evaluated.";

type Coverage = NonNullable<PreflightResponse["evaluationCoverage"]>;

function coverage(overrides: Partial<Coverage> = {}): Coverage {
  return {
    candidateCount: 0,
    submittedCount: 0,
    evaluatedCount: 0,
    status: "not_run",
    semanticBatchCount: 0,
    completedSemanticBatchCount: 0,
    selectionOmissions: [],
    evidenceOmissions: [],
    ...overrides,
  };
}

function response(overrides: Partial<PreflightResponse> = {}): PreflightResponse {
  return {
    protocolVersion: 3,
    verdict: "allow",
    reasonCode: "no_governing_decisions",
    message: "No active governing decisions matched this change.",
    conflicts: [],
    bypassed: [],
    evaluationCoverage: coverage(),
    ...overrides,
  };
}

const evaluated = { candidateCount: 2, submittedCount: 2, evaluatedCount: 2 };
const selectionOmission = {
  source: "candidate_limit",
  reason: "candidate_limit",
  omittedCountLowerBound: 5,
} as const;
const evidenceOmission = { decisionId: "dec_89abcdef", reason: "prompt_budget" } as const;

describe("coverageNote", () => {
  it("says nothing when the check matched no Decision", () => {
    expect(coverageNote(response())).toBe("");
  });

  it("says nothing when the response carries no coverage", () => {
    expect(coverageNote(response({ evaluationCoverage: undefined }))).toBe("");
  });

  it("says nothing when every candidate was evaluated", () => {
    expect(
      coverageNote(
        response({
          reasonCode: "semantically_compatible",
          evaluationCoverage: coverage({ ...evaluated, status: "completed" }),
        }),
      ),
    ).toBe("");
  });

  it("reports candidates that were selected but never evaluated", () => {
    expect(
      coverageNote(
        response({
          reasonCode: "enforcement_disabled",
          evaluationCoverage: coverage({ candidateCount: 2 }),
        }),
      ),
    ).toBe(NOTE);
  });

  it("does not read a missing candidate count as zero", () => {
    const malformed = { status: "not_run" } as unknown as Coverage;
    expect(coverageNote(response({ evaluationCoverage: malformed }))).toBe(NOTE);
  });

  it.each(["partial", "unavailable", "unknown"] as const)("reports a %s evaluation", (status) => {
    expect(coverageNote(response({ evaluationCoverage: coverage({ ...evaluated, status }) }))).toBe(
      NOTE,
    );
    expect(coverageNote(response({ evaluationCoverage: coverage({ status }) }))).toBe(NOTE);
  });

  it("reports omissions from a completed evaluation", () => {
    for (const omissions of [
      { selectionOmissions: [selectionOmission] },
      { evidenceOmissions: [evidenceOmission] },
    ]) {
      expect(
        coverageNote(
          response({
            evaluationCoverage: coverage({ ...evaluated, status: "completed", ...omissions }),
          }),
        ),
      ).toBe(NOTE);
    }
  });

  it("reports omissions from a check that selected no candidates", () => {
    expect(
      coverageNote(
        response({ evaluationCoverage: coverage({ selectionOmissions: [selectionOmission] }) }),
      ),
    ).toBe(NOTE);
  });

  it.each(["ask", "block", "unavailable"] as const)(
    "does not excuse an empty check behind a %s verdict",
    (verdict) => {
      expect(coverageNote(response({ verdict, reasonCode: "preflight_unavailable" }))).toBe(NOTE);
    },
  );

  it("does not excuse an empty check that lists a conflict", () => {
    expect(
      coverageNote(
        response({
          verdict: "warn",
          reasonCode: "semantic_uncertain",
          conflicts: [{ decisionId: "dec_0123abcd" }],
        }),
      ),
    ).toBe(NOTE);
  });

  describe.each(["coverage_unverified", "candidate_set_truncated"])(
    "for the %s outcome, whose reason and guidance are blank",
    (reasonCode) => {
      const warn = (evaluationCoverage: Coverage) =>
        coverageNote(response({ verdict: "warn", reasonCode, evaluationCoverage }));

      it("says nothing when no candidate was selected and nothing was omitted", () => {
        expect(warn(coverage())).toBe("");
      });

      it("reports omissions from a check that selected no candidates", () => {
        expect(warn(coverage({ selectionOmissions: [selectionOmission] }))).toBe(NOTE);
      });

      it("reports omissions from a completed evaluation", () => {
        expect(
          warn(
            coverage({
              ...evaluated,
              status: "completed",
              selectionOmissions: [selectionOmission],
            }),
          ),
        ).toBe(NOTE);
      });

      it("says nothing when every candidate was evaluated and nothing was omitted", () => {
        expect(warn(coverage({ ...evaluated, status: "completed" }))).toBe("");
      });
    },
  );
});
