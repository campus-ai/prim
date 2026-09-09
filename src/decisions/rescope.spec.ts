import { describe, expect, it, vi } from "vitest";
import { type CliClient, HttpError } from "../client.js";
import {
  DECISION_RESCOPE_EXIT,
  type DecisionRescopeDependencies,
  formatRescopeHuman,
  rescopeDecision,
} from "./rescope.js";

const REQUEST = {
  id: "decision-1",
  location: {
    repository: true,
    directories: ["packages/api"],
    globs: ["src/**/*.ts"],
    branches: ["main"],
  },
};

const RESPONSE = {
  outcome: "ok" as const,
  decisionId: "decision-1",
  shortId: "0123abcd",
  stage: "adopted" as const,
  scope: {
    location: {
      repository: true,
      directories: ["packages/api"],
      globs: ["src/**/*.ts"],
      branches: ["main"],
    },
  },
};

function dependencies(post: CliClient["post"]): {
  dependencies: DecisionRescopeDependencies;
  stderr: string[];
  stdout: string[];
} {
  const stderr: string[] = [];
  const stdout: string[] = [];
  return {
    dependencies: {
      getClient: () => ({ get: vi.fn(), post }),
      signal: () => AbortSignal.timeout(1_000),
      writeStderr: (value) => stderr.push(value),
      writeStdout: (value) => stdout.push(value),
    },
    stderr,
    stdout,
  };
}

describe("rescopeDecision", () => {
  it("posts location selectors and emits server warnings through the injected stderr writer", async () => {
    const post = vi
      .fn()
      .mockResolvedValue({ ...RESPONSE, scopeWarnings: ["invalid glob removed"] });
    const output = dependencies(post);

    await expect(rescopeDecision(REQUEST, output.dependencies)).resolves.toBe(
      DECISION_RESCOPE_EXIT.ok,
    );

    expect(post).toHaveBeenCalledWith("/api/cli/decisions/rescope", REQUEST, {
      signal: expect.any(AbortSignal),
    });
    expect(output.stderr).toEqual([
      "[prim] rescope warning: invalid glob removed",
      "[prim] rescoped dec_0123abcd.",
    ]);
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual({
      ...RESPONSE,
      scopeWarnings: ["invalid glob removed"],
    });
  });

  it("sends an explicit null location to clear a Decision's selectors", async () => {
    const post = vi.fn().mockResolvedValue(RESPONSE);
    const output = dependencies(post);

    await rescopeDecision({ id: "decision-1", location: null }, output.dependencies);

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/rescope",
      { id: "decision-1", location: null },
      expect.anything(),
    );
  });

  it("projects only contract-owned response fields to stdout", async () => {
    const post = vi.fn().mockResolvedValue({ ...RESPONSE, internalNote: "do not disclose" });
    const output = dependencies(post);

    await expect(rescopeDecision(REQUEST, output.dependencies)).resolves.toBe(
      DECISION_RESCOPE_EXIT.ok,
    );

    expect(JSON.parse(output.stdout[0] ?? "")).not.toHaveProperty("internalNote");
  });

  it("returns a not-found exit and machine-readable failure for a missing Decision", async () => {
    const post = vi
      .fn()
      .mockRejectedValue(new HttpError(404, "Decision not found", { error: "Decision not found" }));
    const output = dependencies(post);

    await expect(rescopeDecision(REQUEST, output.dependencies)).resolves.toBe(
      DECISION_RESCOPE_EXIT.notFound,
    );

    expect(output.stderr).toEqual(["[prim] rescope rejected: Decision not found."]);
    expect(JSON.parse(output.stdout[0] ?? "")).toEqual({
      ok: false,
      operation: "rescope",
      code: "decision_not_found",
      status: 404,
    });
  });
});

describe("formatRescopeHuman", () => {
  it("renders a no-op using the requested identifier", () => {
    expect(
      formatRescopeHuman(
        { id: "decision-1", location: null },
        {
          outcome: "no_op",
          stage: "adopted",
          scope: { location: { repository: false, directories: [], globs: [], branches: [] } },
        },
      ),
    ).toBe("[prim] decision-1 already has that scope; nothing to change.");
  });
});
