import { describe, expect, it } from "vitest";
import { type ApprovalEvidence, approvalSummary, isEmptyCheck } from "./approval-copy.js";

const UNCHECKED = "Some potentially applicable decisions were not fully checked.";

function summary(overrides: Partial<ApprovalEvidence> = {}): string {
  return approvalSummary(
    {
      conflicts: [],
      message: "Primitive requires review before this change.",
      reasonCode: "review_required",
      verdict: "warn",
      ...overrides,
    },
    "Write “src/retry.ts”.",
  );
}

const noOmissions = { selectionOmissions: [], evidenceOmissions: [] };

describe("isEmptyCheck", () => {
  const empty = { status: "not_run", candidateCount: 0 };
  const check = (overrides: Partial<Parameters<typeof isEmptyCheck>[0]> = {}) =>
    isEmptyCheck({ verdict: "allow", conflicts: [], evaluationCoverage: empty, ...overrides });

  it("holds for an allow or a warn that did not run because it selected no candidates", () => {
    expect(check()).toBe(true);
    expect(check({ verdict: "warn" })).toBe(true);
  });

  it("does not hold when candidates were selected, miscounted or evaluated", () => {
    expect(check({ evaluationCoverage: { status: "not_run", candidateCount: 3 } })).toBe(false);
    expect(check({ evaluationCoverage: { status: "not_run" } })).toBe(false);
    expect(check({ evaluationCoverage: { status: "partial", candidateCount: 0 } })).toBe(false);
    expect(check({ evaluationCoverage: { status: "unknown", candidateCount: 0 } })).toBe(false);
    expect(check({ evaluationCoverage: undefined })).toBe(false);
  });

  it.each(["ask", "block", "unavailable", undefined])("does not hold for verdict %s", (verdict) => {
    expect(check({ verdict })).toBe(false);
  });

  it("does not hold beside a reported conflict", () => {
    expect(check({ conflicts: [{ decisionId: "dec_0123abcd" }] })).toBe(false);
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

  it.each(["ask", "block", "unavailable", undefined])(
    "keeps the line when an empty check arrives with verdict %s",
    (verdict) => {
      expect(
        summary({
          verdict,
          evaluationCoverage: { status: "not_run", candidateCount: 0, ...noOmissions },
        }),
      ).toContain(UNCHECKED);
    },
  );

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
