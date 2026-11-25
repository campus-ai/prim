import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  bind: vi.fn(),
  diagnose: vi.fn(),
  cloud: vi.fn(),
  gate: vi.fn(),
  flag: vi.fn(),
  setActive: vi.fn(),
  markImplicit: vi.fn(),
  withdraw: vi.fn(),
  sessionEnded: vi.fn(),
  identityMode: vi.fn(),
  identify: vi.fn(),
}));

vi.mock("../client.js", () => ({
  getSiteUrl: () => "https://api.example.com",
  isSessionEnded: mocks.sessionEnded,
  HttpError: class HttpError extends Error {
    constructor(
      readonly status: number,
      message: string,
      readonly body?: unknown,
    ) {
      super(message);
    }
  },
}));
vi.mock("../commands/claude-plugin.js", () => ({
  refreshClaudePlugins: async () => ({ installed: 0, refreshed: 0 }),
}));
vi.mock("../commands/skill.js", () => ({
  hasUsableCodexGuidance: () => false,
  hasUsableCursorSkill: () => false,
}));
vi.mock("../daemon/client.js", () => ({ daemonRequest: async () => undefined }));
vi.mock("../daemon/self-heal.js", () => ({ kickDaemonEnsure: () => undefined }));
vi.mock("../lib/activation.js", () => ({
  isRepoActiveForCapture: mocks.gate,
  markActivationImplicit: mocks.markImplicit,
  repoActiveFlag: mocks.flag,
  setRepoActive: mocks.setActive,
  withdrawImplicitActivation: mocks.withdraw,
}));
vi.mock("../lib/bin-cache.js", () => ({ warmBinCache: () => undefined }));
vi.mock("../lib/cloud-session.js", () => ({
  diagnoseCloudSession: mocks.diagnose,
  isClaudeCloudSession: mocks.cloud,
}));
vi.mock("../lib/collect-scope.js", () => ({ fetchAndCacheCollectScope: async () => undefined }));
vi.mock("../lib/commit-heartbeat.js", () => ({
  clearHooksWired: () => undefined,
  recordHooksWired: () => undefined,
}));
vi.mock("../lib/git-hooks.js", () => ({
  MANAGED_GIT_HOOK_NAMES: ["post-commit"],
  ensureEffectiveGitHook: () => ({ outcome: "unchanged" }),
}));
vi.mock("../lib/git.js", () => ({ gitToplevel: () => "/repo" }));
vi.mock("../lib/repository-binding.js", () => ({ bindRepository: mocks.bind }));
vi.mock("../lib/session-identity.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/session-identity.js")>()),
  sessionIdentityMode: mocks.identityMode,
  ensureSessionIdentity: mocks.identify,
}));
vi.mock("../lib/workspace-id.js", () => ({
  getOrCreateWorkspaceId: () => ({ status: "not_git" }),
}));

import { HttpError } from "../client.js";
import { CLOUD_REJECTED_CREDENTIALS_NOTICE } from "../lib/cloud-env.js";
import { processSessionStart } from "./session-start-core.js";

const NOTICE = "Primitive is not connected in this Claude Code cloud session: test.";
const envelope = JSON.stringify({
  hook_event_name: "SessionStart",
  session_id: "session-1",
  cwd: "/repo",
});

type Output = { systemMessage?: string; hookSpecificOutput?: { additionalContext?: string } };

beforeEach(() => {
  mocks.diagnose.mockResolvedValue(NOTICE);
  mocks.bind.mockRejectedValue(new Error("fetch failed"));
  mocks.cloud.mockReturnValue(true);
  mocks.gate.mockReturnValue(true);
  mocks.flag.mockReturnValue("true");
  mocks.withdraw.mockReturnValue(false);
  mocks.sessionEnded.mockReturnValue(false);
  mocks.identityMode.mockReturnValue(false);
});
afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllEnvs();
});

describe("processSessionStart in a Claude Code cloud session", () => {
  it("tells the user and the agent why an active repository could not connect", async () => {
    const { output } = await processSessionStart(envelope, "claude_code");
    const result = output as Output;
    expect(result.systemMessage).toBe(NOTICE);
    expect(result.hookSpecificOutput?.additionalContext).toContain(NOTICE);
  });

  it("stays silent outside a cloud session", async () => {
    mocks.cloud.mockReturnValue(false);
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).systemMessage).toBeUndefined();
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it("does not diagnose a repository that connected", async () => {
    mocks.bind.mockResolvedValue({
      status: "connected",
      repoSyncId: "sync",
      repositoryFullName: "campus-ai/prim",
    });
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).systemMessage).toBeUndefined();
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it("stays fail-soft when the diagnosis itself throws", async () => {
    mocks.diagnose.mockRejectedValue(new Error("boom"));
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).systemMessage).toBeUndefined();
  });
});

describe("a rejected credential at SessionStart in a Claude Code cloud session", () => {
  const RELAY = `${CLOUD_REJECTED_CREDENTIALS_NOTICE} Tell the user this in one sentence before starting their task.`;
  let configDir: string;

  function machineCredentials(extra: Record<string, string | undefined>) {
    vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
    vi.stubEnv("PRIM_CONFIG_DIR", configDir);
    vi.stubEnv("PRIM_TOKEN", undefined);
    vi.stubEnv("PRIM_M2M_CLIENT_ID", "client_cloud");
    vi.stubEnv("PRIM_M2M_CLIENT_SECRET", undefined);
    vi.stubEnv("PRIM_M2M_CLIENT_AUTH", undefined);
    for (const [name, value] of Object.entries(extra)) vi.stubEnv(name, value);
  }

  beforeEach(async () => {
    configDir = mkdtempSync(join(tmpdir(), "prim-session-start-"));
    // The real diagnosis, so the notice is the one a session would show.
    const actual =
      await vi.importActual<typeof import("../lib/cloud-session.js")>("../lib/cloud-session.js");
    mocks.diagnose.mockImplementation(actual.diagnoseCloudSession);
  });
  afterEach(() => rmSync(configDir, { recursive: true, force: true }));

  it("names the rejected credentials when Primitive's API refuses a revoked installation", async () => {
    // The token exchange succeeds; /api/cli/auth/status answers 401. With a
    // network secret the rejection is retried later, so the session is not ended.
    machineCredentials({ PRIM_M2M_CLIENT_AUTH: "network-secret" });
    for (const code of [
      "machine_access_rejected",
      "machine_identity_rejected",
      "machine_credentials_rejected",
    ]) {
      mocks.bind.mockRejectedValue(
        new HttpError(401, "The cloud environment's credentials were rejected.", { error: code }),
      );
      const { output } = await processSessionStart(envelope, "claude_code");
      const result = output as Output;
      expect(result.systemMessage).toBe(CLOUD_REJECTED_CREDENTIALS_NOTICE);
      expect(result.hookSpecificOutput?.additionalContext).toContain(RELAY);
      expect(JSON.stringify(result)).not.toContain("the repository could not be connected");
    }
  });

  it("keeps the same notice for a rejection that ended the session at the token exchange", async () => {
    machineCredentials({ PRIM_M2M_CLIENT_SECRET: "secret" });
    mocks.sessionEnded.mockReturnValue(true);
    mocks.bind.mockRejectedValue(
      new HttpError(401, "rejected", { error: "machine_credentials_rejected" }),
    );
    const { output } = await processSessionStart(envelope, "claude_code");
    expect(output).toEqual({
      systemMessage: CLOUD_REJECTED_CREDENTIALS_NOTICE,
      hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: RELAY },
    });
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it("still sends a repository that is not connected to the developer's machine", async () => {
    machineCredentials({ PRIM_M2M_CLIENT_AUTH: "network-secret" });
    mocks.bind.mockResolvedValue({ status: "unbound", repositoryFullName: "campus-ai/prim" });
    const { output } = await processSessionStart(envelope, "claude_code");
    const result = output as Output;
    expect(result.systemMessage).toBeUndefined();
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      'Primitive needs a one-time GitHub connection for campus-ai/prim. Run `prim github connect` in a clone of it on your own machine, then start a new cloud session."',
    );
    expect(JSON.stringify(result)).not.toContain("credentials were rejected");
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });
});

describe("implicit activation at SessionStart", () => {
  it("marks the flag it writes for an implicit opt-in as prim's own", async () => {
    // Active through a project install or a prepared environment, flag unset.
    mocks.flag.mockReturnValue(undefined);
    await processSessionStart(envelope, "claude_code");
    expect(mocks.setActive).toHaveBeenCalledWith("/repo", true);
    expect(mocks.markImplicit).toHaveBeenCalledWith("/repo");
  });

  it("leaves a flag that is already set alone", async () => {
    await processSessionStart(envelope, "claude_code");
    expect(mocks.setActive).not.toHaveBeenCalled();
    expect(mocks.markImplicit).not.toHaveBeenCalled();
  });

  it("withdraws its own earlier activation before asking whether the repository is active", async () => {
    // The repository has since committed its opt-out: withdrawing unsets the
    // flag, and the gate then answers for the opt-out.
    mocks.withdraw.mockImplementation(() => {
      mocks.gate.mockReturnValue(false);
      return true;
    });
    const { output } = await processSessionStart(envelope, "claude_code");
    expect(mocks.withdraw).toHaveBeenCalledWith("/repo");
    expect(mocks.withdraw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.gate.mock.invocationCallOrder[0] ?? 0,
    );
    expect(mocks.bind).not.toHaveBeenCalled();
    expect((output as Output).systemMessage).toBeUndefined();
  });
});

describe("repository binding at SessionStart", () => {
  // A bind that answers after 1.5 s, the way a cold cloud VM's first bind does.
  function slowBind() {
    mocks.bind.mockImplementation(
      (_root: string, options: { signal: AbortSignal }) =>
        new Promise((resolve, reject) => {
          const timer = setTimeout(
            () =>
              resolve({
                status: "connected",
                repoSyncId: "sync",
                repositoryFullName: "campus-ai/prim",
              }),
            1_500,
          );
          options.signal.addEventListener("abort", () => {
            clearTimeout(timer);
            reject(options.signal.reason);
          });
        }),
    );
  }

  it("gives a cold cloud session time to bind instead of reporting it disconnected", async () => {
    slowBind();
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).systemMessage).toBeUndefined();
    expect(mocks.diagnose).not.toHaveBeenCalled();
    expect((output as Output).hookSpecificOutput?.additionalContext).toContain(
      "GitHub repo connection is complete for campus-ai/prim",
    );
  });

  it("sends an unbound cloud repository to the developer's machine, not a browser flow", async () => {
    mocks.cloud.mockReturnValue(true);
    mocks.bind.mockResolvedValue({ status: "unbound", repositoryFullName: "campus-ai/prim" });
    const { output } = await processSessionStart(envelope, "claude_code");
    const context = (output as Output).hookSpecificOutput?.additionalContext ?? "";
    expect(context).toContain("cannot be completed from this Claude Code cloud session");
    expect(context).not.toContain("drive the browser-based GitHub App workflow");
  });

  it("diagnoses a failed cloud bind against the session's repository and its failure", async () => {
    mocks.cloud.mockReturnValue(true);
    const failure = new Error("fetch failed");
    mocks.bind.mockRejectedValue(failure);
    await processSessionStart(envelope, "claude_code");
    expect(mocks.diagnose).toHaveBeenCalledWith({ cwd: "/repo", bindFailure: failure });
  });

  it("keeps the one-second bind budget on a developer machine", async () => {
    mocks.cloud.mockReturnValue(false);
    slowBind();
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).hookSpecificOutput?.additionalContext ?? "").not.toContain(
      "connection is complete",
    );
  });
});

describe("session identity at SessionStart", () => {
  it("never runs outside session identity mode", async () => {
    await processSessionStart(envelope, "claude_code");
    expect(mocks.identify).not.toHaveBeenCalled();
  });

  it("identifies the session first and says nothing more when it worked", async () => {
    mocks.identityMode.mockReturnValue(true);
    mocks.identify.mockResolvedValue({ status: "ok", displayName: "Jane Doe", reused: false });
    mocks.bind.mockResolvedValue({
      status: "connected",
      repoSyncId: "sync",
      repositoryFullName: "acme/widgets",
    });
    const { output } = await processSessionStart(envelope, "claude_code");
    expect(mocks.identify).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/repo", explicit: true }),
    );
    expect((output as Output).systemMessage).toBeUndefined();
  });

  it("asks the user to link once, and tells the agent how to run the link", async () => {
    mocks.identityMode.mockReturnValue(true);
    mocks.identify.mockResolvedValue({
      status: "link_required",
      githubLogin: "octojane",
      challengeId: "challenge_1",
      challengeExpiresAt: Date.now() + 60_000,
    });
    const { output } = await processSessionStart(envelope, "claude_code");
    const result = output as Output;
    const notice =
      "GitHub account @octojane started this Claude Code cloud session but is not linked to a Primitive account yet. To link it once, run `prim auth link` and sign in at the URL it prints with the code it shows; later sessions then identify you automatically. Until then, nothing this session captures is sent to Primitive.";
    expect(result.systemMessage).toBe(notice);
    expect(result.hookSpecificOutput?.additionalContext).toContain(
      `${notice} Before starting their task, tell the user this in one sentence. When they agree, run \`prim auth link\` as a background command`,
    );
    // The identity notice is the whole story; no second diagnosis competes with it.
    expect(mocks.diagnose).not.toHaveBeenCalled();
  });

  it("names a failure's cause and fix", async () => {
    mocks.identityMode.mockReturnValue(true);
    mocks.identify.mockResolvedValue({
      status: "failed",
      code: "webhook_timeout",
      cause:
        "GitHub's notice of the identity push to acme/widgets did not reach Primitive within 15 s",
      remedy:
        "check that Primitive's GitHub App is installed with access to acme/widgets, then run `prim setup --cloud` to try again",
    });
    const { output } = await processSessionStart(envelope, "claude_code");
    expect((output as Output).systemMessage).toBe(
      "Primitive could not identify who started this Claude Code cloud session: GitHub's notice of the identity push to acme/widgets did not reach Primitive within 15 s. To fix it, check that Primitive's GitHub App is installed with access to acme/widgets, then run `prim setup --cloud` to try again. Until then, nothing this session captures is sent to Primitive.",
    );
  });
});
