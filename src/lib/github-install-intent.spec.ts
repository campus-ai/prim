import { describe, expect, it, vi } from "vitest";
import type { CliClient } from "../client.js";
import {
  type GitHubInstallIntentStart,
  createGitHubInstallIntent,
  parseGitHubInstallIntentStart,
  parseGitHubInstallIntentStatus,
  pollGitHubInstallIntent,
} from "./github-install-intent.js";

const NOW = 1_800_000_000_000;
const EXPIRES_AT = NOW + 60_000;
const START: GitHubInstallIntentStart = {
  protocolVersion: 1,
  mode: "install_intent_v1",
  status: "pending",
  intentId: "intent123",
  browserUrl: `https://github.com/apps/primitive/installations/new?state=${"a".repeat(64)}`,
  expiresAt: EXPIRES_AT,
  pollAfterMs: 1000,
};
const CONSUMED = {
  protocolVersion: 1,
  mode: "install_intent_v1",
  found: true,
  status: "consumed",
  expiresAt: EXPIRES_AT,
  completedAt: NOW + 2_000,
  repositoryCount: 3,
  adminRepositoryCount: 2,
  nonAdminRepositoryCount: 1,
} as const;

function client(responses: unknown[]): CliClient {
  return {
    get: vi.fn(async () => responses.shift()),
    post: vi.fn(async () => responses.shift()),
  };
}

describe("GitHub install-intent protocol", () => {
  it("accepts only the exact canonical start response", () => {
    expect(parseGitHubInstallIntentStart(START, NOW)).toEqual(START);
    expect(parseGitHubInstallIntentStart({ ...START, state: "secret" }, NOW)).toBeNull();
    expect(parseGitHubInstallIntentStart({ ...START, intentId: "intent/123" }, NOW)).toBeNull();
    expect(
      parseGitHubInstallIntentStart(
        {
          ...START,
          browserUrl: `https://attacker.test/apps/primitive/installations/new?state=${"a".repeat(64)}`,
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseGitHubInstallIntentStart(
        {
          ...START,
          browserUrl: `https://github.com/apps/primitive/installations/new?state=${"A".repeat(64)}`,
        },
        NOW,
      ),
    ).toBeNull();
    expect(
      parseGitHubInstallIntentStart({ ...START, expiresAt: NOW + 16 * 60_000 }, NOW),
    ).toBeNull();
  });

  it("uses the generated structural and semantic status validation", () => {
    expect(parseGitHubInstallIntentStatus(CONSUMED, EXPIRES_AT)).toMatchObject({
      status: "consumed",
      repositoryCount: 3,
    });
    expect(
      parseGitHubInstallIntentStatus({ ...CONSUMED, repositoryCount: 4 }, EXPIRES_AT),
    ).toBeNull();
    expect(
      parseGitHubInstallIntentStatus({ ...CONSUMED, completedAt: EXPIRES_AT + 1 }, EXPIRES_AT),
    ).toBeNull();
    expect(
      parseGitHubInstallIntentStatus(
        {
          protocolVersion: 1,
          mode: "install_intent_v1",
          found: true,
          status: "claimed",
          expiresAt: EXPIRES_AT,
          leaseExpiresAt: EXPIRES_AT + 1,
        },
        EXPIRES_AT,
      ),
    ).toBeNull();
    expect(
      parseGitHubInstallIntentStatus(
        {
          protocolVersion: 1,
          mode: "install_intent_v1",
          found: true,
          status: "expired",
          expiresAt: EXPIRES_AT,
          closedAt: EXPIRES_AT + 1,
        },
        EXPIRES_AT,
      ),
    ).toMatchObject({ status: "expired" });
    expect(
      parseGitHubInstallIntentStatus(
        {
          protocolVersion: 1,
          mode: "install_intent_v1",
          found: true,
          status: "cancelled",
          expiresAt: EXPIRES_AT,
          closedAt: EXPIRES_AT + 1,
        },
        EXPIRES_AT,
      ),
    ).toBeNull();
    expect(
      parseGitHubInstallIntentStatus(
        {
          protocolVersion: 1,
          mode: "install_intent_v1",
          found: true,
          status: "failed_terminal",
          expiresAt: EXPIRES_AT,
          closedAt: EXPIRES_AT + 1,
          failureCode: "claim_lease_expired",
        },
        EXPIRES_AT,
      ),
    ).toMatchObject({ status: "failed_terminal" });
    expect(
      parseGitHubInstallIntentStatus(
        {
          protocolVersion: 1,
          mode: "install_intent_v1",
          found: true,
          status: "failed_terminal",
          expiresAt: EXPIRES_AT,
          closedAt: EXPIRES_AT + 1,
          failureCode: "authority_changed",
        },
        EXPIRES_AT,
      ),
    ).toBeNull();
  });

  it("accepts the exact repository identity migration terminal failure", () => {
    expect(
      parseGitHubInstallIntentStatus(
        {
          protocolVersion: 1,
          mode: "install_intent_v1",
          found: true,
          status: "failed_terminal",
          expiresAt: EXPIRES_AT,
          closedAt: NOW + 1,
          failureCode: "repository_identity_migration_required",
        },
        EXPIRES_AT,
      ),
    ).toMatchObject({
      status: "failed_terminal",
      failureCode: "repository_identity_migration_required",
    });
  });

  it("retains bounded repository counts and pins the expected expiry", () => {
    expect(
      parseGitHubInstallIntentStatus(
        {
          ...CONSUMED,
          repositoryCount: 256,
          adminRepositoryCount: 128,
          nonAdminRepositoryCount: 128,
        },
        EXPIRES_AT,
      ),
    ).toMatchObject({ status: "consumed", repositoryCount: 256 });
    expect(
      parseGitHubInstallIntentStatus(
        {
          ...CONSUMED,
          repositoryCount: 257,
          adminRepositoryCount: 128,
          nonAdminRepositoryCount: 129,
        },
        EXPIRES_AT,
      ),
    ).toBeNull();
    expect(parseGitHubInstallIntentStatus(CONSUMED, EXPIRES_AT + 1)).toBeNull();
  });

  it("creates exactly one server-owned intent without a retry", async () => {
    const api = client([START]);
    const signal = AbortSignal.timeout(1000);

    await expect(createGitHubInstallIntent(api, { signal, now: () => NOW })).resolves.toEqual(
      START,
    );

    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/cli/github/install-intents", undefined, {
      signal,
    });
  });

  it("measures the server-owned TTL after the start response arrives", async () => {
    let clock = NOW;
    const issuedAtServerReceipt = {
      ...START,
      expiresAt: NOW + 15 * 60_000 + 25,
    };
    const api: CliClient = {
      get: vi.fn(),
      post: vi.fn(async () => {
        clock += 25;
        return issuedAtServerReceipt;
      }),
    };

    await expect(createGitHubInstallIntent(api, { now: () => clock })).resolves.toEqual(
      issuedAtServerReceipt,
    );
  });

  it("polls pending and claimed states to one consumed terminal state", async () => {
    const api = client([
      {
        protocolVersion: 1,
        mode: "install_intent_v1",
        found: true,
        status: "pending",
        expiresAt: EXPIRES_AT,
      },
      {
        protocolVersion: 1,
        mode: "install_intent_v1",
        found: true,
        status: "claimed",
        expiresAt: EXPIRES_AT,
        leaseExpiresAt: NOW + 30_000,
      },
      {
        protocolVersion: 1,
        mode: "install_intent_v1",
        found: true,
        status: "consumed",
        expiresAt: EXPIRES_AT,
        completedAt: NOW + 3_000,
        repositoryCount: 2,
        adminRepositoryCount: 1,
        nonAdminRepositoryCount: 1,
      },
    ]);
    const sleeps: number[] = [];
    let clock = NOW;

    const result = await pollGitHubInstallIntent(api, START, {
      signal: new AbortController().signal,
      now: () => clock,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
        clock += milliseconds;
      },
    });

    expect(result).toMatchObject({ status: "consumed", adminRepositoryCount: 1 });
    expect(sleeps).toEqual([1000, 1000, 1000]);
    expect(api.get).toHaveBeenCalledTimes(3);
    expect(api.get).toHaveBeenNthCalledWith(1, "/api/cli/github/install-intents/intent123", {
      signal: expect.any(AbortSignal),
    });
  });

  it("returns server cancellation immediately rather than recasting it as expiry", async () => {
    const api = client([
      {
        protocolVersion: 1,
        mode: "install_intent_v1",
        found: true,
        status: "cancelled",
        expiresAt: EXPIRES_AT,
        closedAt: NOW + 1,
      },
    ]);

    await expect(
      pollGitHubInstallIntent(api, START, {
        now: () => NOW,
        sleep: async () => undefined,
      }),
    ).resolves.toMatchObject({ status: "cancelled" });
  });

  it("fails closed on an unrecognized poll response", async () => {
    const api = client([{ ...START, found: true, state: "raw" }]);

    await expect(
      pollGitHubInstallIntent(api, START, {
        signal: new AbortController().signal,
        now: () => NOW,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("invalid GitHub install-intent status");
  });

  it("returns owned expiry without a post-deadline poll", async () => {
    const api = client([]);
    let clock = EXPIRES_AT - 500;

    await expect(
      pollGitHubInstallIntent(api, START, {
        now: () => clock,
        sleep: async (milliseconds) => {
          clock += milliseconds;
        },
      }),
    ).resolves.toMatchObject({ status: "expired", closedAt: EXPIRES_AT });

    expect(api.get).not.toHaveBeenCalled();
  });

  it("preserves external cancellation before and during a sleep", async () => {
    const api = client([]);
    const controller = new AbortController();
    const beforeReason = new Error("cancelled by caller");
    controller.abort(beforeReason);

    await expect(
      pollGitHubInstallIntent(api, START, { signal: controller.signal, now: () => NOW }),
    ).rejects.toBe(beforeReason);

    const duringController = new AbortController();
    const duringReason = new Error("cancelled during wait");
    await expect(
      pollGitHubInstallIntent(api, START, {
        signal: duringController.signal,
        now: () => NOW,
        sleep: async () => {
          duringController.abort(duringReason);
        },
      }),
    ).rejects.toBe(duringReason);

    expect(api.get).not.toHaveBeenCalled();
  });
});
