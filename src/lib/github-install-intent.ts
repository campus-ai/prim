/** Strict client for the server-owned GitHub App installation intent. */

import type { CliClient, RequestOptions } from "../client.js";

const PROTOCOL_VERSION = 1;
const MODE = "install_intent_v1";
const START_PATH = "/api/cli/github/install-intents";
const POLL_REQUEST_TIMEOUT_MS = 10_000;
const MAX_INTENT_LIFETIME_MS = 15 * 60_000;
const INTENT_ID = /^[A-Za-z0-9]{1,128}$/u;
const STATE = /^[0-9a-f]{64}$/u;
const GITHUB_INSTALL_ORIGIN = "https://github.com";
const GITHUB_INSTALL_PATH = "/apps/primitive/installations/new";

export const GITHUB_INSTALL_FAILURE_CODES = [
  "claim_lease_expired",
  "authority_changed",
  "oauth_exchange_failed",
  "installation_not_administered",
  "repository_enumeration_failed",
  "repository_bound_exceeded",
  "installation_changed",
  "proof_commit_failed",
] as const;

export type GitHubInstallFailureCode = (typeof GITHUB_INSTALL_FAILURE_CODES)[number];

export type GitHubInstallIntentStart = Readonly<{
  protocolVersion: 1;
  mode: "install_intent_v1";
  status: "pending";
  intentId: string;
  browserUrl: string;
  expiresAt: number;
  pollAfterMs: 1000;
}>;

type GitHubInstallIntentBase = Readonly<{
  protocolVersion: 1;
  mode: "install_intent_v1";
  found: true;
  expiresAt: number;
}>;

export type GitHubInstallIntentStatus =
  | (GitHubInstallIntentBase & { status: "pending" })
  | (GitHubInstallIntentBase & { status: "claimed"; leaseExpiresAt: number })
  | (GitHubInstallIntentBase & {
      status: "consumed";
      completedAt: number;
      repositoryCount: number;
      adminRepositoryCount: number;
      nonAdminRepositoryCount: number;
    })
  | (GitHubInstallIntentBase & {
      status: "expired" | "cancelled";
      closedAt: number;
    })
  | (GitHubInstallIntentBase & {
      status: "failed_terminal";
      closedAt: number;
      failureCode: GitHubInstallFailureCode;
    });

type RecordValue = Record<string, unknown>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(record: RecordValue, expected: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

function safeTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function safeCount(value: unknown): value is number {
  return safeTimestamp(value);
}

function exactGitHubInstallUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  const entries = [...url.searchParams.entries()];
  const state = entries[0]?.[1] ?? "";
  const canonical = `${GITHUB_INSTALL_ORIGIN}${GITHUB_INSTALL_PATH}?state=${state}`;
  return (
    url.origin === GITHUB_INSTALL_ORIGIN &&
    url.pathname === GITHUB_INSTALL_PATH &&
    url.username === "" &&
    url.password === "" &&
    url.hash === "" &&
    entries.length === 1 &&
    entries[0]?.[0] === "state" &&
    STATE.test(state) &&
    value === canonical
  );
}

export function parseGitHubInstallIntentStart(
  value: unknown,
  now = Date.now(),
): GitHubInstallIntentStart | null {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      "protocolVersion",
      "mode",
      "status",
      "intentId",
      "browserUrl",
      "expiresAt",
      "pollAfterMs",
    ]) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    value.mode !== MODE ||
    value.status !== "pending" ||
    typeof value.intentId !== "string" ||
    !INTENT_ID.test(value.intentId) ||
    !exactGitHubInstallUrl(value.browserUrl) ||
    !safeTimestamp(value.expiresAt) ||
    value.expiresAt <= now ||
    value.expiresAt - now > MAX_INTENT_LIFETIME_MS ||
    value.pollAfterMs !== 1000
  ) {
    return null;
  }
  return value as GitHubInstallIntentStart;
}

const BASE_KEYS = ["protocolVersion", "mode", "found", "status", "expiresAt"] as const;

export function parseGitHubInstallIntentStatus(
  value: unknown,
  expectedExpiresAt: number,
): GitHubInstallIntentStatus | null {
  if (
    !isRecord(value) ||
    value.protocolVersion !== PROTOCOL_VERSION ||
    value.mode !== MODE ||
    value.found !== true ||
    !safeTimestamp(value.expiresAt) ||
    value.expiresAt !== expectedExpiresAt
  ) {
    return null;
  }
  if (value.status === "pending" && exactKeys(value, BASE_KEYS)) {
    return value as GitHubInstallIntentStatus;
  }
  if (
    value.status === "claimed" &&
    exactKeys(value, [...BASE_KEYS, "leaseExpiresAt"]) &&
    safeTimestamp(value.leaseExpiresAt) &&
    value.leaseExpiresAt <= expectedExpiresAt
  ) {
    return value as GitHubInstallIntentStatus;
  }
  if (
    value.status === "consumed" &&
    exactKeys(value, [
      ...BASE_KEYS,
      "completedAt",
      "repositoryCount",
      "adminRepositoryCount",
      "nonAdminRepositoryCount",
    ]) &&
    safeTimestamp(value.completedAt) &&
    value.completedAt <= expectedExpiresAt &&
    safeCount(value.repositoryCount) &&
    safeCount(value.adminRepositoryCount) &&
    safeCount(value.nonAdminRepositoryCount) &&
    value.repositoryCount === value.adminRepositoryCount + value.nonAdminRepositoryCount
  ) {
    return value as GitHubInstallIntentStatus;
  }
  if (
    (value.status === "expired" || value.status === "cancelled") &&
    exactKeys(value, [...BASE_KEYS, "closedAt"]) &&
    safeTimestamp(value.closedAt) &&
    value.closedAt <= expectedExpiresAt
  ) {
    return value as GitHubInstallIntentStatus;
  }
  if (
    value.status === "failed_terminal" &&
    exactKeys(value, [...BASE_KEYS, "closedAt", "failureCode"]) &&
    safeTimestamp(value.closedAt) &&
    value.closedAt <= expectedExpiresAt &&
    typeof value.failureCode === "string" &&
    (GITHUB_INSTALL_FAILURE_CODES as readonly string[]).includes(value.failureCode)
  ) {
    return value as GitHubInstallIntentStatus;
  }
  return null;
}

export async function createGitHubInstallIntent(
  client: CliClient,
  options: RequestOptions & { now?: number } = {},
): Promise<GitHubInstallIntentStart> {
  const { now, ...requestOptions } = options;
  const raw = await client.post(START_PATH, undefined, requestOptions);
  const parsed = parseGitHubInstallIntentStart(raw, now ?? Date.now());
  if (!parsed) throw new Error("server returned an invalid GitHub install-intent response");
  return parsed;
}

function defaultSleep(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise((resolvePromise, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolvePromise();
    }, milliseconds);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function expiredStatus(start: GitHubInstallIntentStart): GitHubInstallIntentStatus {
  return {
    protocolVersion: PROTOCOL_VERSION,
    mode: MODE,
    found: true,
    status: "expired",
    expiresAt: start.expiresAt,
    closedAt: start.expiresAt,
  };
}

export async function pollGitHubInstallIntent(
  client: CliClient,
  start: GitHubInstallIntentStart,
  options: {
    signal?: AbortSignal;
    now?: () => number;
    sleep?: (milliseconds: number, signal: AbortSignal) => Promise<void>;
  },
): Promise<GitHubInstallIntentStatus> {
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const signal = options.signal ?? new AbortController().signal;
  const path = `${START_PATH}/${encodeURIComponent(start.intentId)}`;
  while (true) {
    if (signal.aborted) throw signal.reason;
    const remainingBeforeSleep = start.expiresAt - now();
    if (remainingBeforeSleep <= 0) return expiredStatus(start);
    await sleep(Math.min(start.pollAfterMs, remainingBeforeSleep), signal);
    if (signal.aborted) throw signal.reason;
    const remainingBeforeRequest = start.expiresAt - now();
    if (remainingBeforeRequest <= 0) return expiredStatus(start);

    let raw: unknown;
    try {
      raw = await client.get(path, {
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.min(POLL_REQUEST_TIMEOUT_MS, remainingBeforeRequest)),
        ]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (now() >= start.expiresAt) return expiredStatus(start);
      throw error;
    }
    const status = parseGitHubInstallIntentStatus(raw, start.expiresAt);
    if (!status) throw new Error("server returned an invalid GitHub install-intent status");
    if (status.status !== "pending" && status.status !== "claimed") return status;
  }
}
