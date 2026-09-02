import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { askConfirmation, getClient, post } = vi.hoisted(() => ({
  askConfirmation: vi.fn(),
  getClient: vi.fn(),
  post: vi.fn(),
}));

vi.mock("../client.js", async (importActual) => {
  const actual = await importActual<typeof import("../client.js")>();
  return {
    ...actual,
    getClient,
  };
});

vi.mock("../lib/confirmation.js", async (importActual) => {
  const actual = await importActual<typeof import("../lib/confirmation.js")>();
  return {
    ...actual,
    askConfirmation,
  };
});

import { registerDecisionsCommands } from "./decisions.js";

const ORIGINAL_EXIT_CODE = process.exitCode;

function buildProgram(): Command {
  const program = new Command().exitOverride();
  program.option("--non-interactive", "fail fast instead of prompting");
  registerDecisionsCommands(program);
  return program;
}

beforeEach(() => {
  post.mockReset();
  getClient.mockReset();
  getClient.mockReturnValue({ get: vi.fn(), post });
  askConfirmation.mockReset();
  process.exitCode = 0;
});

afterEach(() => {
  process.exitCode = ORIGINAL_EXIT_CODE;
  vi.restoreAllMocks();
});

describe("decisions lifecycle command registration", () => {
  it("registers the contracted lifecycle verbs", () => {
    const program = buildProgram();
    const decisions = program.commands.find((command) => command.name() === "decisions");
    const names = decisions?.commands.map((command) => command.name()) ?? [];

    expect(names).toContain("publish");
    expect(names).toContain("restore");
    expect(names).toContain("supersede");
    expect(names).toContain("ratify");
    expect(names).toContain("promote");
    expect(names).toContain("demote");
    expect(names).toContain("withdraw");
    expect(names).not.toContain("delete");
    expect(names).not.toContain("edit");
  });

  it("publishes noninteractively without invoking a confirmation prompt", async () => {
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "provisional",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildProgram().parseAsync(["--non-interactive", "decisions", "publish", "decision-1"], {
      from: "user",
    });

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/publish",
      { id: "decision-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledWith("[prim] dec_0123abcd published as provisional.");
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "provisional",
    });
  });

  it("restores noninteractively without invoking a confirmation prompt", async () => {
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "draft",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildProgram().parseAsync(["--non-interactive", "decisions", "restore", "decision-1"], {
      from: "user",
    });

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/restore",
      { id: "decision-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledWith("[prim] dec_0123abcd restored as a private draft.");
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "draft",
    });
  });

  it("ratifies noninteractively without invoking a confirmation prompt", async () => {
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "adopted",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildProgram().parseAsync(["--non-interactive", "decisions", "ratify", "decision-1"], {
      from: "user",
    });

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/ratify",
      { id: "decision-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledWith("[prim] dec_0123abcd ratified as adopted.");
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "adopted",
    });
  });

  it("promotes noninteractively without invoking a confirmation prompt", async () => {
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "adopted",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildProgram().parseAsync(["--non-interactive", "decisions", "promote", "decision-1"], {
      from: "user",
    });

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/ratify",
      { id: "decision-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledWith("[prim] dec_0123abcd promoted as adopted.");
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "adopted",
    });
  });

  it("demotes noninteractively without invoking a confirmation prompt", async () => {
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "provisional",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildProgram().parseAsync(["--non-interactive", "decisions", "demote", "decision-1"], {
      from: "user",
    });

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/demote",
      { id: "decision-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledWith(
      "[prim] dec_0123abcd demoted to provisional — advisory again until re-ratified.",
    );
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "provisional",
    });
  });

  it("withdraws noninteractively without invoking a confirmation prompt", async () => {
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "abandoned",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildProgram().parseAsync(["--non-interactive", "decisions", "withdraw", "decision-1"], {
      from: "user",
    });

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/withdraw",
      { id: "decision-1" },
      { signal: expect.any(AbortSignal) },
    );
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledWith(
      "[prim] dec_0123abcd withdrawn as abandoned — removed from active guidance, not deleted; recover with `prim decisions restore`.",
    );
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      outcome: "ok",
      decisionId: "decision-1",
      shortId: "0123abcd",
      stage: "abandoned",
    });
  });

  it("supersedes noninteractively with a mandatory replacement", async () => {
    post.mockResolvedValueOnce({
      outcome: "ok",
      decisionId: "old-decision",
      stage: "superseded",
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(console, "log").mockImplementation(() => undefined);

    await buildProgram().parseAsync(
      ["--non-interactive", "decisions", "supersede", "old-decision", "--by", "new-decision"],
      { from: "user" },
    );

    expect(post).toHaveBeenCalledWith(
      "/api/cli/decisions/supersede",
      { id: "old-decision", by: "new-decision" },
      { signal: expect.any(AbortSignal) },
    );
    expect(askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(0);
    expect(stderr).toHaveBeenCalledWith("[prim] old-decision superseded by new-decision.");
    expect(JSON.parse(String(stdout.mock.calls[0]?.[0]))).toEqual({
      outcome: "ok",
      decisionId: "old-decision",
      stage: "superseded",
    });
  });

  it("refuses supersede before transport when --by is missing", async () => {
    const program = buildProgram();
    program.configureOutput({ writeErr: () => undefined, writeOut: () => undefined });

    await expect(
      program.parseAsync(["--non-interactive", "decisions", "supersede", "old-decision"], {
        from: "user",
      }),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });
    expect(post).not.toHaveBeenCalled();
    expect(askConfirmation).not.toHaveBeenCalled();
  });
});
