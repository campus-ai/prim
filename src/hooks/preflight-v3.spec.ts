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

  it("does not excuse an empty check that reports a failure or a conflict", () => {
    expect(
      coverageNote(response({ verdict: "unavailable", reasonCode: "preflight_unavailable" })),
    ).toBe(NOTE);
    expect(
      coverageNote(
        response({
          verdict: "ask",
          reasonCode: "high_confidence_contradiction",
          conflicts: [{ decisionId: "dec_0123abcd" }],
        }),
      ),
    ).toBe(NOTE);
  });

  it.each(["coverage_unverified", "candidate_set_truncated"])(
    "stays silent for the %s outcome",
    (reasonCode) => {
      for (const evaluationCoverage of [
        coverage(),
        coverage({ selectionOmissions: [selectionOmission] }),
        coverage({ ...evaluated, status: "completed", selectionOmissions: [selectionOmission] }),
      ]) {
        expect(coverageNote(response({ verdict: "warn", reasonCode, evaluationCoverage }))).toBe(
          "",
        );
      }
    },
  );
});
