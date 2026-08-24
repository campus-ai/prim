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

  it("requires exact status shapes and consistent repository counts", () => {
    expect(
      parseGitHubInstallIntentStatus(
        {
          protocolVersion: 1,
          mode: "install_intent_v1",
          found: true,
          status: "consumed",
          expiresAt: EXPIRES_AT,
          completedAt: NOW + 2_000,
          repositoryCount: 3,
          adminRepositoryCount: 2,
          nonAdminRepositoryCount: 1,
        },
        EXPIRES_AT,
      ),
    ).toMatchObject({ status: "consumed", repositoryCount: 3 });
    expect(
      parseGitHubInstallIntentStatus(
        {
          protocolVersion: 1,
          mode: "install_intent_v1",
          found: true,
          status: "consumed",
          expiresAt: EXPIRES_AT,
          completedAt: NOW + 2_000,
          repositoryCount: 4,
          adminRepositoryCount: 2,
          nonAdminRepositoryCount: 1,
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
          closedAt: NOW + 2_000,
          failureCode: "provider_token_leaked",
        },
        EXPIRES_AT,
      ),
    ).toBeNull();
  });

  it("creates exactly one server-owned intent without a retry", async () => {
    const api = client([START]);
    const signal = AbortSignal.timeout(1000);
    await expect(createGitHubInstallIntent(api, { signal, now: NOW })).resolves.toEqual(START);
    expect(api.post).toHaveBeenCalledExactlyOnceWith("/api/cli/github/install-intents", undefined, {
      signal,
    });
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
});
