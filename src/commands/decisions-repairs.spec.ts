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

import { RepairProposalNotFoundError } from "../decisions/repairs.js";
import { registerDecisionsCommands } from "./decisions.js";

const PROPOSAL_ID = "jd7abc123repairproposal";
const PROPOSED_SHA = "b".repeat(40);
const LIST_RESULT = { repairs: [] };
const ORIGINAL_EXIT_CODE = process.exitCode;

function buildProgram(): Command {
  const program = new Command();
  program.exitOverride();
  registerDecisionsCommands(program);
  return program;
}

function run(...args: string[]): Promise<Command> {
  return buildProgram().parseAsync(args, { from: "user" });
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
  ])("routes the %s list UX", async (_name, args) => {
    await run(...args);

    expect(mocks.fetchRepairs).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith("[prim] decision repairs · 0 repairs need action");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(LIST_RESULT, null, 2));
    expect(process.exitCode).toBe(0);
  });

  it.each(["confirm", "reject"] as const)("routes an explicit %s", async (action) => {
    mocks.resolveRepair.mockResolvedValue({
      proposalId: PROPOSAL_ID,
      action,
      outcome: { status: action === "confirm" ? "confirmed" : "rejected" },
    });

    await run("decisions", "repairs", action, PROPOSAL_ID, PROPOSED_SHA);

    expect(mocks.resolveRepair).toHaveBeenCalledWith(PROPOSAL_ID, PROPOSED_SHA, action);
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ status: action === "confirm" ? "confirmed" : "rejected" }, null, 2),
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining(action));
    expect(process.exitCode).toBe(0);
  });

  it("maps a missing proposal to exit 4 without polluting stdout", async () => {
    mocks.resolveRepair.mockRejectedValue(new RepairProposalNotFoundError(PROPOSAL_ID));

    await run("decisions", "repairs", "confirm", PROPOSAL_ID, PROPOSED_SHA);

    expect(errorSpy).toHaveBeenCalledWith(
      `[prim] Commit repair proposal not found: ${PROPOSAL_ID}`,
    );
    expect(logSpy).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(4);
  });
});
