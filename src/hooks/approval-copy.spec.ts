import { describe, expect, it } from "vitest";
import { type ApprovalEvidence, approvalSummary, nothingToEvaluate } from "./approval-copy.js";

const UNCHECKED = "Some potentially applicable decisions were not fully checked.";

function summary(overrides: Partial<ApprovalEvidence> = {}): string {
  return approvalSummary(
    {
      conflicts: [],
      message: "Primitive requires review before this change.",
      reasonCode: "review_required",
      ...overrides,
    },
    "Write “src/retry.ts”.",
  );
}

const noOmissions = { selectionOmissions: [], evidenceOmissions: [] };

describe("nothingToEvaluate", () => {
  it("holds only for a check that did not run because it selected no candidates", () => {
    expect(nothingToEvaluate({ status: "not_run", candidateCount: 0 })).toBe(true);
    expect(nothingToEvaluate({ status: "not_run", candidateCount: 3 })).toBe(false);
    expect(nothingToEvaluate({ status: "not_run" })).toBe(false);
    expect(nothingToEvaluate({ status: "partial", candidateCount: 0 })).toBe(false);
    expect(nothingToEvaluate({ status: "unknown", candidateCount: 0 })).toBe(false);
    expect(nothingToEvaluate(undefined)).toBe(false);
  });
});

describe("approvalSummary coverage line", () => {
  it("omits the line when the check matched no Decision", () => {
    expect(
      summary({ evaluationCoverage: { status: "not_run", candidateCount: 0, ...noOmissions } }),
    ).not.toContain(UNCHECKED);
  });

  it("omits the line when coverage is absent or completed", () => {
    expect(summary()).not.toContain(UNCHECKED);
    expect(
      summary({ evaluationCoverage: { status: "completed", candidateCount: 2, ...noOmissions } }),
    ).not.toContain(UNCHECKED);
  });

  it("keeps the line when candidates were selected but not evaluated", () => {
    expect(
      summary({ evaluationCoverage: { status: "not_run", candidateCount: 2, ...noOmissions } }),
    ).toContain(UNCHECKED);
  });

  it.each(["partial", "unavailable", "unknown"])("keeps the line for a %s evaluation", (status) => {
    expect(
      summary({ evaluationCoverage: { status, candidateCount: 0, ...noOmissions } }),
    ).toContain(UNCHECKED);
  });

  it("keeps the line when a completed or empty check reports omissions", () => {
    for (const status of ["completed", "not_run"]) {
      for (const omissions of [
        { selectionOmissions: [{}], evidenceOmissions: [] },
        { selectionOmissions: [], evidenceOmissions: [{}] },
      ]) {
        expect(
          summary({ evaluationCoverage: { status, candidateCount: 0, ...omissions } }),
        ).toContain(UNCHECKED);
      }
    }
  });

  it("keeps the line when an empty check arrives beside a conflict", () => {
    expect(
      summary({
        conflicts: [{ decisionId: "dec_0123abcd", title: "Keep retries durable" }],
        evaluationCoverage: { status: "not_run", candidateCount: 0, ...noOmissions },
      }),
    ).toContain(UNCHECKED);
  });

  it.each(["candidate_set_truncated", "evidence_incomplete", "coverage_unverified"])(
    "keeps the line for the %s outcome",
    (reasonCode) => {
      expect(
        summary({
          reasonCode,
          evaluationCoverage: { status: "not_run", candidateCount: 0, ...noOmissions },
        }),
      ).toContain(UNCHECKED);
    },
  );
});
