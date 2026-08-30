/** Strict client for the server-owned GitHub App installation intent. */

import type { CliClient, RequestOptions } from "../client.js";
import {
  type GitHubInstallIntentStartResponse,
  type GitHubInstallIntentStatusResponse,
  isGitHubInstallIntentStartResponse,
  isGitHubInstallIntentStatusResponse,
} from "../contract/cli-http-v1.js";

const PROTOCOL_VERSION = 1;
const MODE = "install_intent_v1";
const START_PATH = "/api/cli/github/install-intents";
const POLL_REQUEST_TIMEOUT_MS = 10_000;
const MAX_INTENT_LIFETIME_MS = 15 * 60_000;

export type GitHubInstallFailureCode = Extract<
  GitHubInstallIntentStatusResponse,
  { status: "failed_terminal" }
>["failureCode"];
export type GitHubInstallIntentStart = GitHubInstallIntentStartResponse;
export type GitHubInstallIntentStatus = GitHubInstallIntentStatusResponse;

export function parseGitHubInstallIntentStart(
  value: unknown,
  now = Date.now(),
): GitHubInstallIntentStart | null {
  if (
    !isGitHubInstallIntentStartResponse(value) ||
    value.expiresAt <= now ||
    value.expiresAt - now > MAX_INTENT_LIFETIME_MS
  ) {
    return null;
  }
  return value;
}

export function parseGitHubInstallIntentStatus(
  value: unknown,
  expectedExpiresAt: number,
): GitHubInstallIntentStatus | null {
  if (!isGitHubInstallIntentStatusResponse(value) || value.expiresAt !== expectedExpiresAt) {
    return null;
  }
  return value;
}

export async function createGitHubInstallIntent(
  client: CliClient,
  options: RequestOptions & { now?: () => number } = {},
): Promise<GitHubInstallIntentStart> {
  const { now = Date.now, ...requestOptions } = options;
  const raw = await client.post(START_PATH, undefined, requestOptions);
  // The server owns this expiry and issues it after receiving the request.
  // Measure its lifetime after the response arrives; a pre-request clock
  // snapshot makes a valid 15-minute intent appear too long by request latency.
  const parsed = parseGitHubInstallIntentStart(raw, now());
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
  } = {},
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
