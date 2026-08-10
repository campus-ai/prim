/** Command routing and stdout/stderr contract for `prim decisions repairs`. */

import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchRepairs: vi.fn(),
  resolveRepair: vi.fn(),
}));

vi.mock("../decisions/repairs.js", async () => {
  const actual =
    await vi.importActual<typeof import("../decisions/repairs.js")>("../decisions/repairs.js");
  return {
    ...actual,
    fetchRepairs: mocks.fetchRepairs,
    resolveRepair: mocks.resolveRepair,
  };
});

import {
  RepairAuthorizationError,
  RepairEndpointVersionError,
  RepairListContractError,
  RepairProposalNotFoundError,
  RepairResolutionInputError,
} from "../decisions/repairs.js";
import { registerDecisionsCommands } from "./decisions.js";

const PROPOSAL_ID = "jd7abc123repairproposal";
const PROPOSED_SHA = "b".repeat(40);
const REVIEW_TOKEN = "c".repeat(64);
const LIST_RESULT = { repairs: [], isDone: true, nextCursor: null, truncated: false } as const;
const ORIGINAL_EXIT_CODE = process.exitCode;

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  program.configureOutput({ writeErr: () => {}, writeOut: () => {} });
  registerDecisionsCommands(program);
  return program;
}

function run(...args: string[]): Promise<Command> {
  return buildProgram().parseAsync(args, { from: "user" });
}

function nestedCommand(program: Command, ...names: string[]): Command {
  let current = program;
  for (const name of names) {
    const next = current.commands.find((command) => command.name() === name);
    if (!next) throw new Error(`missing command ${name}`);
    current = next;
  }
  return current;
}

describe("decisions repairs command", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    process.exitCode = 0;
    mocks.fetchRepairs.mockResolvedValue(LIST_RESULT);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = ORIGINAL_EXIT_CODE;
    vi.restoreAllMocks();
  });

  it.each([
    ["default", ["decisions", "repairs"]],
    ["list", ["decisions", "repairs", "list"]],
  ])("routes the %s exhaustive-list UX", async (_name, args) => {
    await run(...args);

    expect(mocks.fetchRepairs).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      "[prim] decision repairs · 0 review-visible proposals · complete paginated scan",
    );
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(LIST_RESULT, null, 2));
    expect(process.exitCode).toBe(0);
  });

  it("requires and routes the exact explicitly reviewed token on confirm", async () => {
    mocks.resolveRepair.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      action: "confirm",
      outcome: { status: "confirmed" },
    });

    await run(
      "decisions",
      "repairs",
      "confirm",
      PROPOSAL_ID,
      PROPOSED_SHA,
      "--review-token",
      REVIEW_TOKEN,
    );

    expect(mocks.resolveRepair).toHaveBeenCalledWith(
      PROPOSAL_ID,
      PROPOSED_SHA,
      "confirm",
      REVIEW_TOKEN,
    );
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ status: "confirmed" }, null, 2));
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("confirmed"));
    expect(process.exitCode).toBe(0);
  });

  it("routes reject without a review token", async () => {
    mocks.resolveRepair.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      action: "reject",
      outcome: { status: "rejected" },
    });

    await run("decisions", "repairs", "reject", PROPOSAL_ID, PROPOSED_SHA);

    expect(mocks.resolveRepair).toHaveBeenCalledWith(
      PROPOSAL_ID,
      PROPOSED_SHA,
      "reject",
      undefined,
    );
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ status: "rejected" }, null, 2));
    expect(process.exitCode).toBe(0);
  });

  it("documents the required review token on confirm help only", () => {
    const program = buildProgram();
    expect(nestedCommand(program, "decisions", "repairs", "confirm").helpInformation()).toContain(
      "--review-token <token>",
    );
    expect(
      nestedCommand(program, "decisions", "repairs", "reject").helpInformation(),
    ).not.toContain("--review-token");
  });

  it("maps a missing confirm token to local usage failure", async () => {
    mocks.resolveRepair.mockRejectedValue(
      new RepairResolutionInputError(
        "confirm requires --review-token with the 64-character token from the reviewed list",
      ),
    );

    await run("decisions", "repairs", "confirm", PROPOSAL_ID, PROPOSED_SHA);

    expect(mocks.resolveRepair).toHaveBeenCalledWith(
      PROPOSAL_ID,
      PROPOSED_SHA,
      "confirm",
      undefined,
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("64-character token"));
    expect(process.exitCode).toBe(2);
  });

  it("maps a malformed token to usage failure without polluting stdout", async () => {
    mocks.resolveRepair.mockRejectedValue(
      new RepairResolutionInputError(
        "confirm requires --review-token with the 64-character token from the reviewed list",
      ),
    );

    await run(
      "decisions",
      "repairs",
      "confirm",
      PROPOSAL_ID,
      PROPOSED_SHA,
      "--review-token",
      "short",
    );

    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("64-character token"));
    expect(logSpy).not.toHaveBeenCalled();
  });

  it("maps a missing proposal to exit 4 without polluting stdout", async () => {
    mocks.resolveRepair.mockRejectedValue(new RepairProposalNotFoundError(PROPOSAL_ID));

    await run("decisions", "repairs", "reject", PROPOSAL_ID, PROPOSED_SHA);

    expect(errorSpy).toHaveBeenCalledWith(
      `[prim] Commit repair proposal not found: ${PROPOSAL_ID}`,
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(4);
  });

  it("reports confirm protocol version skew with no success output", async () => {
    mocks.resolveRepair.mockRejectedValue(new RepairEndpointVersionError());

    await run(
      "decisions",
      "repairs",
      "confirm",
      PROPOSAL_ID,
      PROPOSED_SHA,
      "--review-token",
      REVIEW_TOKEN,
    );

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("server must be upgraded"));
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("nothing was confirmed or queued"),
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each([
    ["membership", new RepairAuthorizationError()],
    ["version skew", new RepairEndpointVersionError()],
    ["invalid list contract", new RepairListContractError("page 2 is malformed")],
  ])("reports %s list failure with no partial stdout", async (_case, error) => {
    mocks.fetchRepairs.mockRejectedValue(error);

    await run("decisions", "repairs", "list");

    expect(errorSpy).toHaveBeenCalledWith(`[prim] ${error.message}`);
    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it.each(["review_too_large", "stale_review"] as const)(
    "emits the %s domain receipt and a non-zero outcome",
    async (status) => {
      mocks.resolveRepair.mockResolvedValue({
        proposalId: PROPOSAL_ID,
        action: "confirm",
        outcome: { status },
      });

      await run(
        "decisions",
        "repairs",
        "confirm",
        PROPOSAL_ID,
        PROPOSED_SHA,
        "--review-token",
        REVIEW_TOKEN,
      );

      expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ status }, null, 2));
      expect(errorSpy).toHaveBeenCalledWith(expect.stringMatching(/nothing changed/iu));
      expect(process.exitCode).toBe(2);
    },
  );
});
