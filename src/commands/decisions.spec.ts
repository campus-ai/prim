import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  askConfirmation: vi.fn(),
  fetchCreate: vi.fn(),
  isRepoActiveForCapture: vi.fn(),
  setRepoActive: vi.fn(),
}));

vi.mock("../lib/activation.js", () => ({
  isRepoActiveForCapture: mocks.isRepoActiveForCapture,
  setRepoActive: mocks.setRepoActive,
}));

vi.mock("../lib/confirmation.js", async () => {
  const actual =
    await vi.importActual<typeof import("../lib/confirmation.js")>("../lib/confirmation.js");
  return { ...actual, askConfirmation: mocks.askConfirmation };
});

vi.mock("../decisions/create.js", async () => {
  const actual =
    await vi.importActual<typeof import("../decisions/create.js")>("../decisions/create.js");
  return { ...actual, fetchCreate: mocks.fetchCreate };
});

import { registerDecisionsCommands } from "./decisions.js";

const OUTCOME = {
  decisionId: "qx7fpmycwabtzke040y7vecnnh8870pg",
  shortId: "abc12345",
  createdAt: 1_700_000_000_000,
};
const ORIGINAL_EXIT_CODE = process.exitCode;
const PROMPT =
  "[prim] Decision ingestion is disabled here. Create this one Decision without enabling passive ingestion?";
const APPROVED =
  "[prim] one-time Decision creation approved; passive ingestion remains disabled here";
const REJECTED =
  "[prim] decision not created: Decision ingestion is disabled here; rerun with prim's --yes to approve this one Decision, or run `prim enable` in a Git project";
const INACTIVE_JSON = JSON.stringify({ ok: false, error: "prim_inactive" }, null, 2);

function buildProgram(): Command {
  const program = new Command();
  program.option("-y, --yes").option("--non-interactive").exitOverride();
  registerDecisionsCommands(program);
  return program;
}

async function runCreate(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(["decisions", "create", "--intent", "Use X", ...args], {
    from: "user",
  });
}

describe("decisions create activation consent", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetAllMocks();
    vi.stubEnv("CI", "");
    vi.stubEnv("PRIM_NON_INTERACTIVE", "");
    process.exitCode = 0;
    mocks.fetchCreate.mockResolvedValue(OUTCOME);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = ORIGINAL_EXIT_CODE;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("preserves active creation without prompting", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate();

    expect(mocks.isRepoActiveForCapture).toHaveBeenCalledWith(process.cwd());
    expect(mocks.askConfirmation).not.toHaveBeenCalled();
    expect(mocks.fetchCreate).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith("[prim] created dec_abc12345.");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(OUTCOME, null, 2));
    expect(process.exitCode).toBe(0);
  });

  it("allows one inactive creation with Prim's global --yes", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(false);

    await runCreate("--yes");

    expect(mocks.askConfirmation).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenNthCalledWith(1, APPROVED);
    expect(mocks.fetchCreate).toHaveBeenCalledOnce();
    expect(mocks.setRepoActive).not.toHaveBeenCalled();
  });

  it("lets Prim's --yes approve an inactive create in non-interactive mode", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(false);
    vi.stubEnv("CI", "1");

    await runCreate("--yes");

    expect(mocks.askConfirmation).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenNthCalledWith(1, APPROVED);
    expect(mocks.fetchCreate).toHaveBeenCalledOnce();
    expect(process.exitCode).toBe(0);
  });

  it("prompts on stderr and creates once after interactive approval", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(false);
    mocks.askConfirmation.mockResolvedValue(true);

    await runCreate();

    expect(mocks.askConfirmation).toHaveBeenCalledWith(PROMPT, process.stderr);
    expect(errorSpy).toHaveBeenNthCalledWith(1, APPROVED);
    expect(mocks.fetchCreate).toHaveBeenCalledOnce();
    expect(mocks.setRepoActive).not.toHaveBeenCalled();
  });

  it("rejects a declined prompt with only the inactive JSON on stdout", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(false);
    mocks.askConfirmation.mockResolvedValue(false);

    await runCreate();

    expect(errorSpy).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(REJECTED);
    expect(logSpy).toHaveBeenCalledOnce();
    expect(logSpy).toHaveBeenCalledWith(INACTIVE_JSON);
    expect(mocks.fetchCreate).not.toHaveBeenCalled();
    expect(mocks.setRepoActive).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it.each([
    ["--non-interactive", ["--non-interactive"], undefined, undefined],
    ["CI", [], "1", undefined],
    ["PRIM_NON_INTERACTIVE", [], undefined, "1"],
  ])("rejects without prompting in %s mode", async (_name, args, ci, primNonInteractive) => {
    mocks.isRepoActiveForCapture.mockReturnValue(false);
    if (ci) vi.stubEnv("CI", ci);
    if (primNonInteractive) vi.stubEnv("PRIM_NON_INTERACTIVE", primNonInteractive);

    await runCreate(...args);

    expect(mocks.askConfirmation).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(REJECTED);
    expect(logSpy).toHaveBeenCalledWith(INACTIVE_JSON);
    expect(mocks.fetchCreate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
  });

  it("uses the same one-time approval outside Git", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(false);

    await runCreate("--yes");

    expect(errorSpy).toHaveBeenNthCalledWith(1, APPROVED);
    expect(mocks.fetchCreate).toHaveBeenCalledOnce();
    expect(mocks.setRepoActive).not.toHaveBeenCalled();
  });
});
