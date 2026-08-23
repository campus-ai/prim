import { describe, expect, it, vi } from "vitest";
import { type CliClient, HttpError } from "../client.js";
import {
  DECISION_LIFECYCLE_EXIT,
  type DecisionLifecycleCommandDependencies,
  publishDecision,
  restoreDecision,
  supersedeDecision,
} from "./lifecycle.js";

function harness() {
  const post = vi.fn();
  const signal = new AbortController().signal;
  const stdout: string[] = [];
  const stderr: string[] = [];
  const dependencies: DecisionLifecycleCommandDependencies = {
    getClient: () => ({ post, get: vi.fn() }) as CliClient,
    signal: () => signal,
    writeStdout: (value) => stdout.push(value),
    writeStderr: (value) => stderr.push(value),
  };
  return { dependencies, post, signal, stderr, stdout };
}

function httpError(
  status: number,
  message: string,
  extra: Record<string, unknown> = {},
): HttpError {
  return new HttpError(status, message, { error: message, ...extra });
}

function machineOutput(stdout: string[]): Record<string, unknown> {
  expect(stdout).toHaveLength(1);
  return JSON.parse(stdout[0]) as Record<string, unknown>;
}

describe("Decision lifecycle success contract", () => {
  it("publishes with the generated request and projects only generated success fields", async () => {
    const { dependencies, post, signal, stderr, stdout } = harness();
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "provisional",
      internalReceipt: "must-not-print",
    });

    const exitCode = await publishDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.ok);
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/publish",
      { id: "decision-1" },
      { signal },
    );
    expect(machineOutput(stdout)).toEqual({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "provisional",
    });
    expect(stdout.join("\n")).not.toContain("must-not-print");
    expect(stderr).toEqual(["[prim] dec_0123abcd published as provisional."]);
  });

  it("treats a publish no-op as success and does not leak additive fields", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({
      outcome: "no_op",
      stage: "provisional",
      decisionId: "unexpected-additive-id",
      secret: "must-not-print",
    });

    const exitCode = await publishDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.ok);
    expect(machineOutput(stdout)).toEqual({ outcome: "no_op", stage: "provisional" });
    expect(stdout.join("\n")).not.toContain("must-not-print");
    expect(stderr).toEqual(["[prim] decision-1 is already provisional; nothing to change."]);
  });

  it("restores with the generated request and projects only generated success fields", async () => {
    const { dependencies, post, signal, stderr, stdout } = harness();
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "draft",
      internalReceipt: "must-not-print",
    });

    const exitCode = await restoreDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.ok);
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/restore",
      { id: "decision-1" },
      { signal },
    );
    expect(machineOutput(stdout)).toEqual({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "draft",
    });
    expect(stdout.join("\n")).not.toContain("must-not-print");
    expect(stderr).toEqual(["[prim] dec_0123abcd restored as a private draft."]);
  });

  it("treats an already-restored draft as a successful no-op", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({ outcome: "no_op", stage: "draft" });

    const exitCode = await restoreDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.ok);
    expect(machineOutput(stdout)).toEqual({ outcome: "no_op", stage: "draft" });
    expect(stderr).toEqual(["[prim] decision-1 is already draft; nothing to change."]);
  });

  it("supersedes with the generated request and makes the direction explicit", async () => {
    const { dependencies, post, signal, stderr, stdout } = harness();
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "old-decision",
      shortId: "old12345",
      stage: "superseded",
    });

    const exitCode = await supersedeDecision("old-decision", "new-decision", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.ok);
    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/supersede",
      { id: "old-decision", by: "new-decision" },
      { signal },
    );
    expect(machineOutput(stdout)).toEqual({
      outcome: "ok",
      decisionId: "old-decision",
      shortId: "old12345",
      stage: "superseded",
    });
    expect(stderr).toEqual(["[prim] dec_old12345 superseded by new-decision."]);
  });

  it("treats an already-superseded response as a successful no-op", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({ outcome: "no_op", stage: "superseded" });

    const exitCode = await supersedeDecision("old-decision", "new-decision", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.ok);
    expect(machineOutput(stdout)).toEqual({ outcome: "no_op", stage: "superseded" });
    expect(stderr).toEqual(["[prim] old-decision is already superseded; nothing to change."]);
  });

  it("rejects a generated-union response whose stage contradicts its endpoint", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      stage: "adopted",
      sensitive: "must-not-print",
    });

    const exitCode = await publishDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.server);
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "publish",
      code: "invalid_response",
    });
    expect(stderr[0]).toContain("invalid lifecycle response");
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain("must-not-print");
  });

  it("rejects a generated restore response whose stage contradicts its endpoint", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      stage: "provisional",
      sensitive: "must-not-print",
    });

    const exitCode = await restoreDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.server);
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "restore",
      code: "invalid_response",
    });
    expect(stderr[0]).toContain("invalid lifecycle response");
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain("must-not-print");
  });

  it("rejects a malformed success body without reflecting it", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({ outcome: "ok", token: "sensitive-success-value" });

    const exitCode = await publishDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.server);
    expect(machineOutput(stdout).code).toBe("invalid_response");
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain("sensitive-success-value");
  });

  it("keeps machine JSON unchanged while sanitizing human identifiers", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-\u001b]8;;https://bad.example\u0007link",
      shortId: "short\u202e-id",
      stage: "superseded",
    });

    const exitCode = await supersedeDecision("old", "replacement\u001b[31m\u2066-id", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.ok);
    expect(machineOutput(stdout).shortId).toBe("short\u202e-id");
    for (const unsafe of ["\u001b", "\u0007", "\u202e", "\u2066"]) {
      expect(stderr[0]).not.toContain(unsafe);
    }
  });
});

describe("Decision lifecycle error contract and exits", () => {
  it.each([
    {
      name: "author rejection",
      status: 403,
      message: "Only the decision's author can perform this action",
      code: "not_author",
      exitCode: DECISION_LIFECYCLE_EXIT.rejected,
    },
    {
      name: "ambiguous identifier",
      status: 409,
      message: "shortId is ambiguous in this organization; retry with the full decision id",
      code: "ambiguous_identifier",
      exitCode: DECISION_LIFECYCLE_EXIT.rejected,
    },
    {
      name: "immutable decision",
      status: 409,
      message: "An adopted decision is immutable — supersede it to change it",
      code: "immutable",
      exitCode: DECISION_LIFECYCLE_EXIT.rejected,
    },
    {
      name: "illegal stage transition",
      status: 409,
      message: "Cannot move an adopted decision to provisional",
      code: "illegal_transition",
      exitCode: DECISION_LIFECYCLE_EXIT.rejected,
    },
    {
      name: "illegal stage transition with a consonant article",
      status: 409,
      message: "Cannot move a provisional decision to draft",
      code: "illegal_transition",
      exitCode: DECISION_LIFECYCLE_EXIT.rejected,
    },
    {
      name: "missing decision",
      status: 404,
      message: "Decision not found",
      code: "decision_not_found",
      exitCode: DECISION_LIFECYCLE_EXIT.notFound,
    },
    {
      name: "organization-unbound credential",
      status: 403,
      message: "CLI token is not bound to an organization",
      code: "organization_unbound",
      exitCode: DECISION_LIFECYCLE_EXIT.auth,
    },
    {
      name: "old server route",
      status: 404,
      message: "Not found",
      code: "unsupported_server",
      exitCode: DECISION_LIFECYCLE_EXIT.server,
    },
  ])("codes $name without reflecting additive error fields", async (testCase) => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockRejectedValueOnce(
      httpError(testCase.status, testCase.message, { token: "sensitive-error-value" }),
    );

    const exitCode = await publishDecision("decision-1", dependencies);

    expect(exitCode).toBe(testCase.exitCode);
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "publish",
      code: testCase.code,
      status: testCase.status,
    });
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain("sensitive-error-value");
  });

  it("codes a restore transition rejection without reflecting server fields", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockRejectedValueOnce(
      httpError(409, "Cannot move an adopted decision to draft", {
        token: "sensitive-error-value",
      }),
    );

    const exitCode = await restoreDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.rejected);
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "restore",
      code: "illegal_transition",
      status: 409,
    });
    expect(stderr).toEqual([
      "[prim] restore rejected: the Decision's current lifecycle stage cannot be restored.",
    ]);
    expect(`${stdout.join("\n")} ${stderr.join("\n")}`).not.toContain("sensitive-error-value");
  });

  it("codes an old server without accepting an uncontracted restore result", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockRejectedValueOnce(httpError(404, "Not found"));

    const exitCode = await restoreDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.server);
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "restore",
      code: "unsupported_server",
      status: 404,
    });
    expect(stderr[0]).toContain("restore unavailable");
  });

  it.each([
    {
      name: "self replacement",
      status: 400,
      message: "A decision cannot supersede itself",
      code: "invalid_replacement",
      exitCode: DECISION_LIFECYCLE_EXIT.rejected,
    },
    {
      name: "missing replacement",
      status: 404,
      message: "Replacement decision not found",
      code: "replacement_not_found",
      exitCode: DECISION_LIFECYCLE_EXIT.notFound,
    },
  ])("codes supersede $name", async (testCase) => {
    const { dependencies, post, stdout } = harness();
    post.mockRejectedValueOnce(httpError(testCase.status, testCase.message));

    const exitCode = await supersedeDecision("old", "replacement", dependencies);

    expect(exitCode).toBe(testCase.exitCode);
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "supersede",
      code: testCase.code,
      status: testCase.status,
    });
  });

  it("codes a local 401 without requiring a server error envelope", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockRejectedValueOnce(
      new HttpError(401, "Authentication expired. Run `prim auth login` to re-authenticate."),
    );

    const exitCode = await publishDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.auth);
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "publish",
      code: "authentication_required",
      status: 401,
    });
    expect(stderr[0]).toContain("prim auth login");
  });

  it("rejects an invalid error envelope without reflecting raw fields", async () => {
    const { dependencies, post, stderr, stdout } = harness();
    post.mockRejectedValueOnce(
      new HttpError(409, "unsafe", {
        message: "\u001b]8;;https://bad.example\u0007sensitive-error-value",
        token: "sensitive-token",
      }),
    );

    const exitCode = await publishDecision("decision-1", dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.server);
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "publish",
      code: "invalid_error_response",
      status: 409,
    });
    const rendered = `${stdout.join("\n")} ${stderr.join("\n")}`;
    for (const unsafe of ["sensitive", "bad.example", "\u001b"]) {
      expect(rendered).not.toContain(unsafe);
    }
  });

  it("does not reflect unknown server or transport error messages", async () => {
    const server = harness();
    server.post.mockRejectedValueOnce(
      httpError(500, "database token sensitive-server-value", { trace: "sensitive-trace" }),
    );
    expect(await publishDecision("decision-1", server.dependencies)).toBe(
      DECISION_LIFECYCLE_EXIT.server,
    );
    expect(machineOutput(server.stdout).code).toBe("server_error");
    expect(`${server.stdout.join("\n")} ${server.stderr.join("\n")}`).not.toContain("sensitive");

    const transport = harness();
    transport.post.mockRejectedValueOnce(new Error("fetch token sensitive-transport-value"));
    expect(await publishDecision("decision-1", transport.dependencies)).toBe(
      DECISION_LIFECYCLE_EXIT.server,
    );
    expect(machineOutput(transport.stdout).code).toBe("transport_error");
    expect(`${transport.stdout.join("\n")} ${transport.stderr.join("\n")}`).not.toContain(
      "sensitive",
    );
  });

  it("fails locally when a caller bypasses the generated request type", async () => {
    const { dependencies, post, stdout } = harness();

    const exitCode = await supersedeDecision("old", undefined as unknown as string, dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.rejected);
    expect(post).not.toHaveBeenCalled();
    expect(machineOutput(stdout).code).toBe("invalid_request");
  });

  it("fails locally when restore is called without a generated-contract identifier", async () => {
    const { dependencies, post, stdout } = harness();

    const exitCode = await restoreDecision(undefined as unknown as string, dependencies);

    expect(exitCode).toBe(DECISION_LIFECYCLE_EXIT.rejected);
    expect(post).not.toHaveBeenCalled();
    expect(machineOutput(stdout)).toEqual({
      ok: false,
      operation: "restore",
      code: "invalid_request",
    });
  });
});
