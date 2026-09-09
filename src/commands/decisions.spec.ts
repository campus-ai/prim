import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  askConfirmation: vi.fn(),
  fetchCreate: vi.fn(),
  isRepoActiveForCapture: vi.fn(),
  repoSyncId: vi.fn(),
  setRepoActive: vi.fn(),
  canonicalRepositoryPath: vi.fn(),
  rescopeDecision: vi.fn(),
}));

vi.mock("../lib/activation.js", () => ({
  isRepoActiveForCapture: mocks.isRepoActiveForCapture,
  repoSyncId: mocks.repoSyncId,
  setRepoActive: mocks.setRepoActive,
}));

vi.mock("../lib/git.js", () => ({
  canonicalGitRoot: vi.fn(() => "/repo"),
  canonicalRepositoryPath: mocks.canonicalRepositoryPath,
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

vi.mock("../decisions/rescope.js", () => ({ rescopeDecision: mocks.rescopeDecision }));

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
  const attribution = args.includes("--attribution") ? [] : ["--attribution", "user"];
  await buildProgram().parseAsync(
    ["decisions", "create", "--intent", "Use X", ...attribution, ...args],
    { from: "user" },
  );
}

async function runRescope(...args: string[]): Promise<void> {
  await buildProgram().parseAsync(["decisions", "rescope", "decision-1", ...args], {
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
    mocks.rescopeDecision.mockResolvedValue(0);
    mocks.repoSyncId.mockReturnValue("sync-1");
    mocks.canonicalRepositoryPath.mockImplementation((path: string) => path);
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
    expect(mocks.fetchCreate).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: "user" }),
    );
    expect(errorSpy).toHaveBeenCalledWith("[prim] created dec_abc12345.");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(OUTCOME, null, 2));
    expect(process.exitCode).toBe(0);
  });

  it("passes agent attribution through to the create request", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate("--attribution", "agent");

    expect(mocks.fetchCreate).toHaveBeenCalledWith(
      expect.objectContaining({ attribution: "agent" }),
    );
  });

  it.each([
    ["--draft", "draft"],
    ["--adopt", "adopted"],
  ] as const)("passes %s as stage override %s", async (flag, stageOverride) => {
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate(flag);

    expect(mocks.fetchCreate).toHaveBeenCalledWith(expect.objectContaining({ stageOverride }));
  });

  it("rejects conflicting lifecycle birth flags before transport", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate("--draft", "--adopt");

    expect(mocks.fetchCreate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(
      "[prim] create rejected: --draft and --adopt cannot be used together.",
    );
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, error: "conflicting_stage_override" }, null, 2),
    );
  });

  it("collects repeated --decided and --alternatives entries verbatim, commas intact", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate(
      "--decided",
      "Consume AADT, safety, and speed data from street_export",
      "--decided",
      "gps_probes_osm is no longer a data source",
      "--alternatives",
      "Keep gps_probes_osm, patched",
    );

    expect(mocks.fetchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        decided: [
          "Consume AADT, safety, and speed data from street_export",
          "gps_probes_osm is no longer a data source",
        ],
        alternatives: ["Keep gps_probes_osm, patched"],
      }),
    );
  });

  it("resolves repo-relative --files from the Git root before sending v3 scope", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate("--files", "src/a.ts,src/b.ts", "--files", "src/c.ts");

    expect(mocks.fetchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: 3,
        repoSyncId: "sync-1",
        files: ["src/a.ts", "src/b.ts", "src/c.ts"],
      }),
    );
    expect(mocks.canonicalRepositoryPath).toHaveBeenNthCalledWith(1, "src/a.ts", "/repo", "/repo");
  });

  it("sends coarse scope selectors without canonicalizing directory or glob syntax", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate(
      "--scope-repo",
      "--scope-dir",
      "packages/api",
      "--scope-dir",
      "apps/web",
      "--scope-glob",
      "src/**/*.test.ts",
      "--scope-branch",
      "main",
    );

    expect(mocks.fetchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        protocolVersion: 3,
        repoSyncId: "sync-1",
        scope: {
          location: {
            repository: true,
            directories: ["packages/api", "apps/web"],
            globs: ["src/**/*.test.ts"],
            branches: ["main"],
          },
        },
      }),
    );
    expect(mocks.canonicalRepositoryPath).not.toHaveBeenCalled();
  });

  it("sends ISO time flags without requiring a repository binding", async () => {
    mocks.repoSyncId.mockReturnValue(undefined);
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate(
      "--effective-from",
      "2026-09-08T00:00:00Z",
      "--effective-until",
      "1789158896789",
    );

    expect(mocks.fetchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          time: {
            effectiveFrom: Date.parse("2026-09-08T00:00:00Z"),
            effectiveUntil: 1_789_158_896_789,
          },
        },
      }),
    );
    expect(mocks.repoSyncId).not.toHaveBeenCalled();
  });

  it("sends repeated audience selectors without requiring a repository binding", async () => {
    mocks.repoSyncId.mockReturnValue(undefined);
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate(
      "--for-user",
      "user-1",
      "--for-user",
      "user-2",
      "--for-role",
      "admin",
      "--for-agent",
      "codex",
      "--for-credential",
      "service_token",
    );

    expect(mocks.fetchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          users: [
            { kind: "user", userId: "user-1" },
            { kind: "user", userId: "user-2" },
            { kind: "role", role: "admin" },
            { kind: "agent", agent: "codex" },
            { kind: "credential", credential: "service_token" },
          ],
        },
      }),
    );
    expect(mocks.repoSyncId).not.toHaveBeenCalled();
  });

  it("rejects an invalid audience selector before prompting or transport", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(false);

    await runCreate("--for-agent", "not-a-client");

    expect(mocks.fetchCreate).not.toHaveBeenCalled();
    expect(mocks.askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--for-agent"));
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, error: "invalid_user_scope" }, null, 2),
    );
  });

  it("combines location and time scope at create", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate("--scope-dir", "packages/api", "--effective-from", "2026-09-08T00:00:00Z");

    expect(mocks.fetchCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: {
          location: { directories: ["packages/api"] },
          time: { effectiveFrom: Date.parse("2026-09-08T00:00:00Z") },
        },
      }),
    );
  });

  it("rejects invalid time flags before prompting or transport", async () => {
    mocks.isRepoActiveForCapture.mockReturnValue(false);

    await runCreate("--effective-from", "not-a-date");

    expect(mocks.fetchCreate).not.toHaveBeenCalled();
    expect(mocks.askConfirmation).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("--effective-from"));
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ ok: false, error: "invalid_effective_window" }, null, 2),
    );
  });

  it("rejects --files locally when the repository is unbound", async () => {
    mocks.repoSyncId.mockReturnValue(undefined);
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate("--files", "src/a.ts");

    expect(mocks.fetchCreate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("run `prim enable`"));
  });

  it("rejects location scope locally when the repository is unbound", async () => {
    mocks.repoSyncId.mockReturnValue(undefined);
    mocks.isRepoActiveForCapture.mockReturnValue(true);

    await runCreate("--scope-dir", "packages/api");

    expect(mocks.fetchCreate).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(2);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("run `prim enable`"));
    expect(mocks.canonicalRepositoryPath).not.toHaveBeenCalled();
  });

  it("requires an explicit attribution", async () => {
    await expect(
      buildProgram().parseAsync(["decisions", "create", "--intent", "Use X"], {
        from: "user",
      }),
    ).rejects.toMatchObject({ code: "commander.missingMandatoryOptionValue" });

    expect(mocks.fetchCreate).not.toHaveBeenCalled();
  });

  it("rejects attribution outside user or agent", async () => {
    await expect(runCreate("--attribution", "unknown")).rejects.toMatchObject({
      code: "commander.invalidArgument",
    });

    expect(mocks.fetchCreate).not.toHaveBeenCalled();
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

  it("rescopes time without clearing location selectors", async () => {
    await runRescope("--effective-until", "1789158896789");

    expect(mocks.rescopeDecision).toHaveBeenCalledWith({
      id: "decision-1",
      time: { effectiveUntil: 1_789_158_896_789 },
    });
  });

  it("resets an audience with user selectors without requiring a time option", async () => {
    await runRescope("--for-user", "user-1", "--for-role", "member", "--for-agent", "hermes");

    expect(mocks.rescopeDecision).toHaveBeenCalledWith({
      id: "decision-1",
      users: [
        { kind: "user", userId: "user-1" },
        { kind: "role", role: "member" },
        { kind: "agent", agent: "hermes" },
      ],
    });
  });

  it("rescopes location and time together", async () => {
    await runRescope("--scope-glob", "**/*.sql", "--effective-from", "2026-09-08T00:00:00Z");

    expect(mocks.rescopeDecision).toHaveBeenCalledWith({
      id: "decision-1",
      location: { globs: ["**/*.sql"] },
      time: { effectiveFrom: Date.parse("2026-09-08T00:00:00Z") },
    });
  });

  it("rescopes location and audience together without clearing either dimension", async () => {
    await runRescope("--scope-dir", "packages/api", "--for-role", "admin");

    expect(mocks.rescopeDecision).toHaveBeenCalledWith({
      id: "decision-1",
      location: { directories: ["packages/api"] },
      users: [{ kind: "role", role: "admin" }],
    });
  });
});
