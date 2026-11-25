import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { CLOUD_GITHUB_CONNECT_REMEDY, isClaudeCloudSession } from "./cloud-env.js";
import { withFileLock } from "./file-lock.js";
import {
  currentBranch,
  gitChildEnvironment,
  gitToplevel,
  githubRepositoryFullName,
} from "./git.js";
import {
  type MachineCredential,
  type MachineDependencies,
  acquireMachineCredential,
  environmentCredentials,
  forwardMachineRequest,
  prepareMachineMetadataDirectory,
  readMachineMetadata,
  writeMachineMetadata,
} from "./machine-credentials.js";
import {
  MachineAuthError,
  type MachineIdentity,
  machineApiUrl,
  machineRecord,
  machineString,
  verifyMachineIdentity,
} from "./machine-protocol.js";
import { primConfigDirectory } from "./paths.js";
import { terminalSafeLine } from "./terminal-safe.js";
import { readBoundedJson } from "./workos-connect.js";

/**
 * Session identity: one Claude Code cloud environment shared by a team.
 *
 * The environment holds an organization-level environment credential whose
 * only scope is `cli:session-identity`. Each session proves who started it
 * through GitHub: Claude Code's git proxy pushes the session's own
 * `claude/…` branch as the session starter's GitHub account, so prim creates
 * that branch on GitHub at the session's starting commit (Claude Code would
 * create the same branch when it first pushes). Primitive's GitHub App sees
 * the push's sender and, if that account is linked to a member, returns a
 * short-lived token that acts as that member. The environment credential is
 * used only for the session-identity routes; every other request carries the
 * member's session token.
 */

/** The cloud environment variable that selects session identity. */
export const SESSION_IDENTITY_VARIABLE = "PRIM_CLOUD_IDENTITY";
export const SESSION_IDENTITY_VALUE = "session";
/** Claude Code's id for the running cloud session. */
const SESSION_ID_VARIABLE = "CLAUDE_CODE_REMOTE_SESSION_ID";
/** Undocumented Claude Code variable; sent only as a cross-check. */
const USER_EMAIL_VARIABLE = "CLAUDE_CODE_USER_EMAIL";
const SESSION_TOKEN_PREFIX = "prim_sess_";
const SESSION_BRANCH = /^claude\/[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/u;
const SHA = /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/u;

export const SESSION_IDENTITY_ROUTES = {
  challenge: "/api/cli/session-identity/challenge",
  token: "/api/cli/session-identity/token",
  refresh: "/api/cli/session-identity/token/refresh",
  link: "/api/cli/session-identity/link",
} as const;

const DEFAULT_API_URL = "https://api.getprimitive.ai";
const RENEW_BEFORE_MS = 60_000;
const GIT_TIMEOUT_MS = 10_000;
const POLL_BUDGET_MS = 15_000;
const POLL_FIRST_DELAY_MS = 500;
const POLL_MAX_DELAY_MS = 3_000;
/** A hook process does not retry a failed identity check sooner than this. */
const BACKGROUND_RETRY_MS = 5 * 60_000;
const LOCK_TIMEOUT_MS = 60_000;
const RESPONSE_MAX_BYTES = 64 * 1024;

export type SessionIdentityDependencies = MachineDependencies & {
  /** Test seams: how long to poll and how to wait between polls. */
  pollBudgetMs?: number;
  sleep?: (milliseconds: number, signal?: AbortSignal) => Promise<void>;
};

/** True in a Claude Code cloud session whose environment asks for session identity. */
export function sessionIdentityRequested(env: NodeJS.ProcessEnv = process.env): boolean {
  return (
    isClaudeCloudSession(env) && env[SESSION_IDENTITY_VARIABLE]?.trim() === SESSION_IDENTITY_VALUE
  );
}

/**
 * Session identity mode: requested, and the environment carries the machine
 * credential the identity routes authenticate with. Outside it nothing changes.
 */
export function sessionIdentityMode(deps: MachineDependencies = {}): boolean {
  const env = deps.env ?? process.env;
  return (
    sessionIdentityRequested(env) &&
    (env.PRIM_M2M_CLIENT_ID !== undefined ||
      env.PRIM_M2M_CLIENT_SECRET !== undefined ||
      env.PRIM_M2M_CLIENT_AUTH !== undefined)
  );
}

export type SessionIdentityFailure = {
  status: "failed";
  code: string;
  /** What went wrong, as a clause: "the session branch … already exists on GitHub". */
  cause: string;
  /** The fix, as an imperative clause: "start a new cloud session". */
  remedy: string;
};
export type SessionLinkRequired = {
  status: "link_required";
  githubLogin: string;
  challengeId: string;
  challengeExpiresAt: number;
};
export type SessionIdentified = {
  status: "ok";
  credential: MachineCredential;
  displayName: string;
  githubLogin?: string;
  /** True when a cached or refreshed token answered, with no identity push. */
  reused: boolean;
};
export type SessionIdentityOutcome =
  | SessionIdentified
  | SessionLinkRequired
  | SessionIdentityFailure;

function failure(code: string, cause: string, remedy: string): SessionIdentityFailure {
  return { status: "failed", code, cause, remedy };
}

const RETRY_REMEDY = "run `prim setup --cloud` to try again";
const NEW_SESSION_REMEDY = "start a new cloud session";

/** The one-sentence message for an outcome, in the style of the cloud notices. */
export function sessionIdentityMessage(
  outcome: SessionLinkRequired | SessionIdentityFailure,
): string {
  if (outcome.status === "link_required")
    return `GitHub account @${outcome.githubLogin} started this Claude Code cloud session but is not linked to a Primitive account yet. To link it once, run \`prim auth link\` and sign in at the URL it prints with the code it shows; later sessions then identify you automatically.`;
  return `Primitive could not identify who started this Claude Code cloud session: ${outcome.cause}. To fix it, ${outcome.remedy}.`;
}

type SessionContext = {
  directory: string;
  apiUrl: string;
  clientId: string;
  generation: string;
  sessionId: string;
  tokenPath: string;
  statePath: string;
  lockPath: string;
};

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionContext(deps: MachineDependencies): SessionContext | SessionIdentityFailure {
  const env = deps.env ?? process.env;
  const environment = environmentCredentials(deps);
  if (!environment)
    return failure(
      "environment_credential_missing",
      "the cloud environment has no environment credential",
      'ask an organization admin to create one with `prim auth enroll --new-environment "<name>" --print-env` and add it to the environment, then start a new cloud session',
    );
  const sessionId = env[SESSION_ID_VARIABLE]?.trim();
  if (!sessionId || !machineString(sessionId, 256))
    return failure(
      "session_id_missing",
      `this Claude Code cloud session does not report its session ID (${SESSION_ID_VARIABLE})`,
      NEW_SESSION_REMEDY,
    );
  const apiUrl = machineApiUrl(env.PRIM_API_URL?.trim() || DEFAULT_API_URL);
  const directory = deps.directory ?? primConfigDirectory({ env });
  const key = hash(`${apiUrl}\0${environment.clientId}\0${sessionId}`);
  return {
    directory,
    apiUrl,
    clientId: environment.clientId,
    generation: environment.generation,
    sessionId,
    tokenPath: join(directory, `session_identity_${key}.json`),
    statePath: join(directory, `session_identity_${key}.state.json`),
    lockPath: join(directory, "session-identity.lock"),
  };
}

/** The member's session token, cached owner-only for this session's processes. */
type SessionTokenRecord = {
  version: 1;
  apiUrl: string;
  clientId: string;
  generation: string;
  sessionId: string;
  issuer: string;
  audience: string;
  accessToken: string;
  expiresAt: number;
  refreshAfter: number;
  userId: string;
  displayName: string;
  organizationId: string;
  githubLogin?: string;
  identity: MachineIdentity;
  repositoryRoot?: string;
};

/** Why the last identity attempt did not produce a token, for later processes. */
type SessionStateRecord = {
  version: 1;
  sessionId: string;
  status: "link_required" | "failed";
  code: string;
  cause?: string;
  remedy?: string;
  githubLogin?: string;
  challengeId?: string;
  challengeExpiresAt?: number;
  repositoryRoot?: string;
  branch?: string;
  baseSha?: string;
  at: number;
};

function readRecord(path: string): Record<string, unknown> | undefined {
  try {
    const value = readMachineMetadata(path);
    return value === undefined ? undefined : machineRecord(value);
  } catch {
    // An unreadable or unsafe cache is not a credential; identify again.
    return undefined;
  }
}

function finiteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function readToken(context: SessionContext): SessionTokenRecord | undefined {
  const data = readRecord(context.tokenPath);
  if (
    !data ||
    data.version !== 1 ||
    data.apiUrl !== context.apiUrl ||
    data.clientId !== context.clientId ||
    data.generation !== context.generation ||
    data.sessionId !== context.sessionId ||
    !machineString(data.accessToken, 8192) ||
    !data.accessToken.startsWith(SESSION_TOKEN_PREFIX) ||
    !finiteNumber(data.expiresAt) ||
    !finiteNumber(data.refreshAfter) ||
    !machineString(data.userId, 256) ||
    !machineString(data.displayName, 256) ||
    !machineString(data.organizationId, 256) ||
    !machineString(data.issuer, 2048) ||
    !machineString(data.audience, 256)
  )
    return undefined;
  const identity = data.identity as MachineIdentity | undefined;
  if (
    !identity ||
    identity.clientId !== context.clientId ||
    identity.authorizedUserId !== data.userId ||
    identity.organizationId !== data.organizationId
  )
    return undefined;
  return data as unknown as SessionTokenRecord;
}

function readState(context: SessionContext): SessionStateRecord | undefined {
  const data = readRecord(context.statePath);
  if (
    !data ||
    data.version !== 1 ||
    data.sessionId !== context.sessionId ||
    (data.status !== "link_required" && data.status !== "failed") ||
    typeof data.code !== "string" ||
    !finiteNumber(data.at)
  )
    return undefined;
  return data as unknown as SessionStateRecord;
}

function writeToken(context: SessionContext, record: SessionTokenRecord): void {
  prepareMachineMetadataDirectory(context.directory);
  writeMachineMetadata(context.tokenPath, record);
  rmSync(context.statePath, { force: true });
}

function writeState(context: SessionContext, state: Omit<SessionStateRecord, "version">): void {
  try {
    prepareMachineMetadataDirectory(context.directory);
    writeMachineMetadata(context.statePath, { version: 1, ...state });
  } catch {
    // The state only spares later processes a repeat; losing it is harmless.
  }
}

function tokenValid(record: SessionTokenRecord, now = Date.now()): boolean {
  return now < record.expiresAt - RENEW_BEFORE_MS;
}
function tokenFresh(record: SessionTokenRecord, now = Date.now()): boolean {
  return tokenValid(record, now) && now < record.refreshAfter;
}

function toCredential(record: SessionTokenRecord): MachineCredential {
  return {
    issuer: record.issuer,
    audience: record.audience,
    ...record.identity,
    accessToken: record.accessToken,
    expiresAt: record.expiresAt,
    apiUrl: record.apiUrl,
    generation: record.generation,
    storage: "environment",
    session: {
      userId: record.userId,
      displayName: record.displayName,
      ...(record.githubLogin ? { githubLogin: record.githubLogin } : {}),
      refreshAfter: record.refreshAfter,
    },
  };
}

function identified(record: SessionTokenRecord, reused: boolean): SessionIdentified {
  return {
    status: "ok",
    credential: toCredential(record),
    displayName: record.displayName,
    ...(record.githubLogin ? { githubLogin: record.githubLogin } : {}),
    reused,
  };
}

/**
 * The session's member credential from the shared cache, without network, or
 * undefined while the session has none that is still valid. Journal routing
 * reads this: a capture made without it waits as identity-pending.
 */
export function cachedSessionCredential(
  deps: MachineDependencies = {},
): MachineCredential | undefined {
  if (!sessionIdentityMode(deps)) return undefined;
  let context: SessionContext | SessionIdentityFailure;
  try {
    context = sessionContext(deps);
  } catch {
    return undefined;
  }
  if ("status" in context) return undefined;
  const record = readToken(context);
  return record && tokenValid(record) ? toCredential(record) : undefined;
}

/** The last attempt's outcome as later processes and diagnostics see it. */
export function lastSessionIdentityOutcome(
  deps: MachineDependencies = {},
): SessionLinkRequired | SessionIdentityFailure | undefined {
  try {
    const context = sessionContext(deps);
    if ("status" in context) return context;
    const state = readState(context);
    return state ? outcomeFromState(state) : undefined;
  } catch {
    return undefined;
  }
}

function outcomeFromState(state: SessionStateRecord): SessionLinkRequired | SessionIdentityFailure {
  if (state.status === "link_required" && state.githubLogin && state.challengeId)
    return {
      status: "link_required",
      githubLogin: state.githubLogin,
      challengeId: state.challengeId,
      challengeExpiresAt: state.challengeExpiresAt ?? 0,
    };
  return failure(
    state.code,
    state.cause ?? "the last identity check failed",
    state.remedy ?? RETRY_REMEDY,
  );
}

/** An absolute instant from a server field: epoch milliseconds, epoch seconds, or ISO 8601. */
function parseInstant(value: unknown): number | undefined {
  if (finiteNumber(value) && value > 0) return value < 1e12 ? value * 1000 : value;
  if (typeof value === "string" && value.length <= 64) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

type ApiAnswer = { status: number; value: Record<string, unknown> | undefined };

async function sendJson(
  url: string,
  init: { method: string; headers: Record<string, string>; body?: string; signal?: AbortSignal },
  fetchImpl: typeof fetch,
): Promise<ApiAnswer> {
  const response = await fetchImpl(url, { ...init, redirect: "error" });
  let value: Record<string, unknown> | undefined;
  try {
    const parsed = await readBoundedJson(response, RESPONSE_MAX_BYTES);
    value =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
  } catch {
    value = undefined;
  }
  return { status: response.status, value };
}

/** The environment credential itself, never the session's member credential. */
function environmentOnly(deps: MachineDependencies): MachineDependencies {
  return { ...deps, environmentOnly: true };
}

/**
 * One request to a session-identity route with the environment credential.
 * With a proxy-held token it goes through the broker like every other
 * request in that mode; otherwise it carries the environment's own token.
 */
async function environmentRequest(
  method: "GET" | "POST",
  path: string,
  body: unknown,
  deps: SessionIdentityDependencies,
  signal?: AbortSignal,
): Promise<ApiAnswer> {
  const send = async (credential: MachineCredential): Promise<ApiAnswer> => {
    const headers = { "Content-Type": "application/json" };
    const text = body === undefined ? undefined : JSON.stringify(body);
    if (credential.tokenInjection) {
      const response = await forwardMachineRequest(
        { method, path, headers, ...(text === undefined ? {} : { body: text }) },
        signal,
        environmentOnly(deps),
      );
      const parsed = await response.json().catch(() => undefined);
      return {
        status: response.status,
        value:
          parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? (parsed as Record<string, unknown>)
            : undefined,
      };
    }
    return sendJson(
      `${credential.apiUrl}${path}`,
      {
        method,
        headers: { ...headers, Authorization: `Bearer ${credential.accessToken}` },
        ...(text === undefined ? {} : { body: text }),
        signal: signal ?? AbortSignal.timeout(GIT_TIMEOUT_MS),
      },
      deps.fetch ?? fetch,
    );
  };
  let credential = await acquireMachineCredential({ signal }, environmentOnly(deps));
  if (!credential) throw new MachineAuthError("identity_unavailable", "No environment credential.");
  let answer = await send(credential);
  if (answer.status === 401) {
    credential = await acquireMachineCredential({ force: true, signal }, environmentOnly(deps));
    if (!credential)
      throw new MachineAuthError("identity_unavailable", "No environment credential.");
    answer = await send(credential);
  }
  return answer;
}

function environmentFailure(error: unknown, apiUrl: string): SessionIdentityFailure {
  if (error instanceof MachineAuthError && error.terminal)
    return failure(
      "environment_credential_rejected",
      "Primitive rejected the cloud environment's credential",
      'ask the organization admin who set up the environment to check its credential, or to mint a replacement with `prim auth enroll --new-environment "<name>" --print-env`; then start a new cloud session',
    );
  const host = (() => {
    try {
      return new URL(apiUrl).hostname;
    } catch {
      return "Primitive";
    }
  })();
  return failure(
    "identity_unavailable",
    `Primitive could not be reached for the identity check${
      error instanceof MachineAuthError ? ` (${terminalSafeLine(error.message).slice(0, 200)})` : ""
    }`,
    `check that ${host} is under the cloud environment's Allowed domains, then ${RETRY_REMEDY}`,
  );
}

function answerError(answer: ApiAnswer): string | undefined {
  return typeof answer.value?.error === "string" ? answer.value.error : undefined;
}

/** Git with no prompts; failures come back as data, never as thrown errors. */
async function git(
  root: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ ok: boolean; code?: number; stdout: string; stderr: string; timedOut: boolean }> {
  try {
    // Bound per call: importing this module must not touch child_process.
    const { stdout, stderr } = await promisify(execFile)("git", args, {
      cwd: root,
      encoding: "utf8",
      timeout: GIT_TIMEOUT_MS,
      signal,
      env: { ...gitChildEnvironment(), GIT_TERMINAL_PROMPT: "0" },
      maxBuffer: 1024 * 1024,
    });
    return { ok: true, code: 0, stdout, stderr, timedOut: false };
  } catch (error) {
    const failed = error as NodeJS.ErrnoException & {
      code?: number | string;
      killed?: boolean;
      signal?: string;
      stdout?: string;
      stderr?: string;
    };
    return {
      ok: false,
      code: typeof failed.code === "number" ? failed.code : undefined,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? "",
      timedOut: failed.killed === true || failed.signal === "SIGTERM",
    };
  }
}

/** The last line git wrote, safe to show; a URL never keeps its userinfo. */
function gitDetail(stderr: string): string {
  const lines = stderr
    .split("\n")
    .map((line) => terminalSafeLine(line.replace(/\/\/[^/\s@]+@/gu, "//")))
    .filter(Boolean);
  return (
    lines.find((line) => /error|denied|refused|forbidden|403|fatal/iu.test(line)) ??
    lines.at(-1) ??
    "no detail"
  ).slice(0, 200);
}

async function defaultSleep(milliseconds: number, signal?: AbortSignal): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, milliseconds);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

type ChallengeStatus =
  | { status: "verified"; githubLogin?: string; linked?: boolean }
  | { status: "pending" | "expired" }
  | { status: "rejected"; reason: string };

async function pollChallenge(
  apiUrl: string,
  challengeId: string,
  repository: string,
  deps: SessionIdentityDependencies,
  signal?: AbortSignal,
): Promise<{ githubLogin?: string } | SessionIdentityFailure> {
  const sleep = deps.sleep ?? defaultSleep;
  const deadline = Date.now() + (deps.pollBudgetMs ?? POLL_BUDGET_MS);
  let delay = POLL_FIRST_DELAY_MS;
  let unreachable: unknown;
  for (;;) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await sleep(Math.min(delay, remaining), signal);
    delay = Math.min(POLL_MAX_DELAY_MS, Math.round(delay * 1.5));
    let answer: ApiAnswer;
    try {
      answer = await environmentRequest(
        "GET",
        `${SESSION_IDENTITY_ROUTES.challenge}/${encodeURIComponent(challengeId)}`,
        undefined,
        deps,
        signal,
      );
    } catch (error) {
      signal?.throwIfAborted();
      unreachable = error;
      continue;
    }
    if (answer.status < 200 || answer.status > 299) {
      unreachable = new MachineAuthError("identity_unavailable", `HTTP ${answer.status}`);
      continue;
    }
    unreachable = undefined;
    const status = answer.value as ChallengeStatus | undefined;
    if (status?.status === "verified")
      return {
        ...(machineString((status as { githubLogin?: unknown }).githubLogin, 64)
          ? { githubLogin: (status as { githubLogin: string }).githubLogin }
          : {}),
      };
    if (status?.status === "expired")
      return failure(
        "challenge_expired",
        `the identity check expired before Primitive received GitHub's notice of the push to ${repository}`,
        NEW_SESSION_REMEDY,
      );
    if (status?.status === "rejected") {
      const reason = (status as { reason?: unknown }).reason;
      if (reason === "identity_mismatch")
        return failure(
          "identity_mismatch",
          "the session branch was created by a GitHub account linked to a different Primitive member than the one signed in to Claude, so Primitive attributes this session to no one",
          `${NEW_SESSION_REMEDY}; if it happens again, ask an organization admin to check members' GitHub links`,
        );
      return failure(
        "challenge_rejected",
        `Primitive rejected the identity push to ${repository}${
          typeof reason === "string" ? ` (${terminalSafeLine(reason).slice(0, 120)})` : ""
        }`,
        `${NEW_SESSION_REMEDY}; if it happens again, ask an organization admin to check Primitive's GitHub App on ${repository}`,
      );
    }
  }
  if (unreachable) return environmentFailure(unreachable, apiUrl);
  return failure(
    "webhook_timeout",
    `GitHub's notice of the identity push to ${repository} did not reach Primitive within ${Math.round((deps.pollBudgetMs ?? POLL_BUDGET_MS) / 1000)} s`,
    `check that Primitive's GitHub App is installed with access to ${repository}, then ${RETRY_REMEDY}`,
  );
}

type TokenAnswer = {
  accessToken: string;
  expiresAt: number;
  refreshAfter: number;
  userId: string;
  displayName: string;
  organizationId: string;
};

function parseTokenAnswer(value: Record<string, unknown> | undefined): TokenAnswer | undefined {
  if (!value) return undefined;
  const user = value.user as Record<string, unknown> | undefined;
  const expiresAt = parseInstant(value.expiresAt);
  const refreshAfter = parseInstant(value.refreshAfter) ?? expiresAt;
  if (
    !machineString(value.accessToken, 8192) ||
    !value.accessToken.startsWith(SESSION_TOKEN_PREFIX) ||
    !expiresAt ||
    !refreshAfter ||
    !user ||
    !machineString(user.id, 256) ||
    !machineString(user.displayName, 256) ||
    !machineString(value.organizationId, 256)
  )
    return undefined;
  return {
    accessToken: value.accessToken,
    expiresAt,
    refreshAfter: Math.min(refreshAfter, expiresAt),
    userId: user.id,
    displayName: user.displayName,
    organizationId: value.organizationId,
  };
}

const SERVER_CONTRACT_FAILURE = failure(
  "server_contract",
  "Primitive's answer did not identify the linked member",
  "update prim (`npx --yes @primitive.ai/prim@latest`) and run `prim setup --cloud`; if it persists, report it to Primitive",
);

/**
 * Check what the session token acts as before anything is attributed to it:
 * the API must answer for it as the token's own member, through the
 * environment's client, so captures bind to exactly that member.
 */
async function recordFor(
  context: SessionContext,
  answer: TokenAnswer,
  extra: { githubLogin?: string; repositoryRoot?: string },
  deps: SessionIdentityDependencies,
  signal?: AbortSignal,
): Promise<SessionTokenRecord | SessionIdentityFailure> {
  let identity: MachineIdentity;
  let environment: MachineCredential | undefined;
  try {
    environment = await acquireMachineCredential({ signal }, environmentOnly(deps));
    identity = await verifyMachineIdentity(
      context.apiUrl,
      answer.accessToken,
      context.clientId,
      signal,
      deps.fetch,
    );
  } catch (error) {
    if (error instanceof MachineAuthError && error.code === "machine_identity_rejected")
      return SERVER_CONTRACT_FAILURE;
    return environmentFailure(error, context.apiUrl);
  }
  if (
    !environment ||
    identity.authorizedUserId !== answer.userId ||
    identity.organizationId !== answer.organizationId
  )
    return SERVER_CONTRACT_FAILURE;
  return {
    version: 1,
    apiUrl: context.apiUrl,
    clientId: context.clientId,
    generation: context.generation,
    sessionId: context.sessionId,
    issuer: environment.issuer,
    audience: environment.audience,
    accessToken: answer.accessToken,
    expiresAt: answer.expiresAt,
    refreshAfter: answer.refreshAfter,
    userId: answer.userId,
    displayName: answer.displayName,
    organizationId: answer.organizationId,
    ...(extra.githubLogin ? { githubLogin: extra.githubLogin } : {}),
    identity,
    ...(extra.repositoryRoot ? { repositoryRoot: extra.repositoryRoot } : {}),
  };
}

async function refreshToken(
  context: SessionContext,
  record: SessionTokenRecord,
  deps: SessionIdentityDependencies,
  signal?: AbortSignal,
): Promise<SessionTokenRecord | undefined> {
  try {
    const answer = await environmentRequest(
      "POST",
      SESSION_IDENTITY_ROUTES.refresh,
      { accessToken: record.accessToken },
      deps,
      signal,
    );
    const token = answer.status === 200 ? parseTokenAnswer(answer.value) : undefined;
    if (!token || token.userId !== record.userId || token.organizationId !== record.organizationId)
      return undefined;
    // The member and their verified binding are unchanged; only the token is new.
    return {
      ...record,
      accessToken: token.accessToken,
      expiresAt: token.expiresAt,
      refreshAfter: token.refreshAfter,
      displayName: token.displayName,
    };
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

/** Exchange a verified challenge for the member's token. */
async function exchangeChallenge(
  context: SessionContext,
  challenge: { challengeId: string; challengeExpiresAt: number; githubLogin?: string },
  repositoryRoot: string | undefined,
  deps: SessionIdentityDependencies,
  signal?: AbortSignal,
): Promise<SessionTokenRecord | SessionLinkRequired | SessionIdentityFailure> {
  let answer: ApiAnswer;
  try {
    answer = await environmentRequest(
      "POST",
      SESSION_IDENTITY_ROUTES.token,
      { challengeId: challenge.challengeId },
      deps,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    return environmentFailure(error, context.apiUrl);
  }
  if (answer.status === 409 && answerError(answer) === "github_account_not_linked") {
    const login = answer.value?.githubLogin;
    return {
      status: "link_required",
      githubLogin: machineString(login, 64) ? login : (challenge.githubLogin ?? "unknown"),
      challengeId: challenge.challengeId,
      challengeExpiresAt: challenge.challengeExpiresAt,
    };
  }
  const token = answer.status === 200 ? parseTokenAnswer(answer.value) : undefined;
  if (!token) {
    if (answer.status === 401 || answer.status === 403)
      return environmentFailure(new MachineAuthError("rejected", "rejected", true), context.apiUrl);
    return answer.status >= 500
      ? environmentFailure(
          new MachineAuthError("identity_unavailable", `HTTP ${answer.status}`),
          context.apiUrl,
        )
      : SERVER_CONTRACT_FAILURE;
  }
  return recordFor(
    context,
    token,
    { githubLogin: challenge.githubLogin, repositoryRoot },
    deps,
    signal,
  );
}

type Attempt = {
  root: string;
  branch?: string;
  baseSha?: string;
  challengeId?: string;
  challengeExpiresAt?: number;
  githubLogin?: string;
};

/**
 * Prove who started the session: create its `claude/…` branch on GitHub at the
 * starting commit, then wait for Primitive to see who pushed it.
 */
async function challengeAndPush(
  context: SessionContext,
  root: string,
  previous: SessionStateRecord | undefined,
  deps: SessionIdentityDependencies,
  attempt: Attempt,
  signal?: AbortSignal,
): Promise<
  SessionIdentityFailure | { challengeId: string; challengeExpiresAt: number; repository: string }
> {
  const env = deps.env ?? process.env;
  const repository = githubRepositoryFullName(root);
  if (!repository)
    return failure(
      "repository_unidentified",
      "this checkout does not name its GitHub repository",
      "run it in the repository the session cloned; for a checkout with no GitHub origin, commit its repository declaration with `prim claude install --scope project` from a clone whose origin is on GitHub",
    );
  const branch = currentBranch(root);
  if (!branch || !SESSION_BRANCH.test(branch) || branch.includes("..") || branch.endsWith(".lock"))
    return failure(
      "not_session_branch",
      `this checkout is on ${branch ? `branch ${terminalSafeLine(branch).slice(0, 120)}` : "a detached HEAD"}, not the session's own claude/… branch, so prim cannot prove who started the session and pushed nothing`,
      `${NEW_SESSION_REMEDY} and let it identify you before switching branches`,
    );
  attempt.branch = branch;
  // The commit the session started from. A retry in the same session keeps it,
  // whatever has been committed locally since.
  let baseSha = previous?.branch === branch && previous.baseSha ? previous.baseSha : undefined;
  if (!baseSha) {
    const head = await git(root, ["rev-parse", "--verify", "HEAD^{commit}"], signal);
    baseSha = head.stdout.trim();
    if (!head.ok || !SHA.test(baseSha))
      return failure(
        "no_commit",
        "this checkout has no commit to create the session branch at",
        NEW_SESSION_REMEDY,
      );
  }
  // The branch is created at a commit GitHub already has, so the push
  // publishes no commit. Identification can run after the agent committed
  // locally (an explicit retry, or a session start that never recorded its
  // base), and then HEAD carries work the person never chose to push.
  const published = await git(
    root,
    [
      "for-each-ref",
      "--count=1",
      "--format=%(refname)",
      "--contains",
      baseSha,
      "refs/remotes/origin/",
    ],
    signal,
  );
  if (!published.ok || published.stdout.trim() === "")
    return failure(
      "unpublished_commits",
      `this checkout's commit ${baseSha.slice(0, 12)} is not on GitHub yet, and creating the session branch at it would publish it, so prim pushed nothing`,
      `${NEW_SESSION_REMEDY} and let it identify you before committing`,
    );
  attempt.baseSha = baseSha;
  // Creation only: a branch already on GitHub (a resumed VM, or the agent
  // pushed it) proves nothing about who started this session, so push nothing.
  const remote = await git(
    root,
    ["ls-remote", "--exit-code", "origin", `refs/heads/${branch}`],
    signal,
  );
  if (remote.ok)
    return failure(
      "branch_exists",
      `the session branch ${branch} already exists on GitHub, so this session cannot prove who started it`,
      NEW_SESSION_REMEDY,
    );
  if (remote.code !== 2)
    return failure(
      remote.timedOut ? "push_timeout" : "remote_unavailable",
      `prim could not check ${repository} for the session branch (${remote.timedOut ? "timed out" : gitDetail(remote.stderr)})`,
      `check the session's access to ${repository} on GitHub, then ${RETRY_REMEDY}`,
    );

  let answer: ApiAnswer;
  try {
    const email = env[USER_EMAIL_VARIABLE]?.trim();
    answer = await environmentRequest(
      "POST",
      SESSION_IDENTITY_ROUTES.challenge,
      {
        repositoryFullName: repository,
        claudeSessionId: context.sessionId,
        branch,
        baseSha,
        ...(email && machineString(email, 320) ? { userEmailHint: email } : {}),
      },
      deps,
      signal,
    );
  } catch (error) {
    signal?.throwIfAborted();
    return environmentFailure(error, context.apiUrl);
  }
  if (answer.status === 404 && answerError(answer) === "repository_not_connected")
    return failure(
      "repository_not_connected",
      `${repository} is not connected to Primitive`,
      CLOUD_GITHUB_CONNECT_REMEDY,
    );
  if (answer.status === 401 || answer.status === 403)
    return environmentFailure(new MachineAuthError("rejected", "rejected", true), context.apiUrl);
  const challengeId = answer.value?.challengeId;
  const challengeExpiresAt = parseInstant(answer.value?.expiresAt);
  if (answer.status !== 200 || !machineString(challengeId, 256) || !challengeExpiresAt)
    return answer.status >= 500 || answer.status === 429
      ? environmentFailure(
          new MachineAuthError("identity_unavailable", `HTTP ${answer.status}`),
          context.apiUrl,
        )
      : SERVER_CONTRACT_FAILURE;
  // The server names the ref; prim pushes only the session's own branch.
  if (answer.value?.ref !== `refs/heads/${branch}`) return SERVER_CONTRACT_FAILURE;
  attempt.challengeId = challengeId;
  attempt.challengeExpiresAt = challengeExpiresAt;

  // An internal push of one existing commit to a branch that does not exist
  // yet: no upstream, no force, nothing else. --no-verify and the empty hooks
  // path keep every hook out of it (the repository's pre-push hook and prim's
  // own git hooks), since it is not the user's push and must not be captured
  // or gated as one. This is the only place prim skips hooks. Push settings
  // the checkout may carry would add to it (push.followTags sends annotated
  // tags, push.recurseSubmodules pushes submodules, push.gpgSign and
  // push.pushOption send more than the ref), so each is overridden: the
  // explicit refspec is the only thing that leaves.
  const push = await git(
    root,
    [
      "-c",
      "core.hooksPath=/dev/null",
      "-c",
      "push.followTags=false",
      "-c",
      "push.recurseSubmodules=no",
      "-c",
      "push.gpgSign=false",
      "-c",
      "push.pushOption=",
      "push",
      "--no-verify",
      "--no-follow-tags",
      "--no-recurse-submodules",
      "--no-signed",
      "--quiet",
      "origin",
      `${baseSha}:refs/heads/${branch}`,
    ],
    signal,
  );
  if (!push.ok)
    return push.timedOut
      ? failure(
          "push_timeout",
          `creating the session branch ${branch} on ${repository} did not finish in ${GIT_TIMEOUT_MS / 1000} s`,
          `check the session's network access to GitHub, then ${RETRY_REMEDY}`,
        )
      : failure(
          "push_refused",
          `creating the session branch ${branch} on ${repository} was refused (${gitDetail(push.stderr)})`,
          `check that the GitHub account that started this session can push to ${repository} and that the cloud environment lets the session push, then ${NEW_SESSION_REMEDY}`,
        );
  return { challengeId, challengeExpiresAt, repository };
}

export type EnsureSessionIdentityOptions = {
  /** The checkout to identify through; defaults to the one recorded earlier. */
  cwd?: string;
  /**
   * A person or session start asked for it: may create the session branch,
   * and ignores the retry pause hook processes honor.
   */
  explicit?: boolean;
  force?: boolean;
  observedToken?: string;
  signal?: AbortSignal;
};

/**
 * Make sure this session has its member's token: the cached one, a refreshed
 * one, or one from a new GitHub identity check. One process at a time does
 * this; the others wait and take its result from the cache.
 */
export async function ensureSessionIdentity(
  options: EnsureSessionIdentityOptions = {},
  deps: SessionIdentityDependencies = {},
): Promise<SessionIdentityOutcome> {
  let context: SessionContext | SessionIdentityFailure;
  try {
    context = sessionContext(deps);
  } catch (error) {
    return failure(
      "environment_credential_invalid",
      error instanceof MachineAuthError
        ? terminalSafeLine(error.message).replace(/\.$/u, "")
        : "the environment credential is misconfigured",
      "correct the cloud environment's PRIM_M2M_* variables, then start a new cloud session",
    );
  }
  if ("status" in context) return context;
  const ctx = context;
  const startedAt = Date.now();
  prepareMachineMetadataDirectory(ctx.directory);
  return withFileLock(
    ctx.lockPath,
    async (): Promise<SessionIdentityOutcome> => {
      const record = readToken(ctx);
      const forced =
        options.force === true &&
        (!options.observedToken || options.observedToken === record?.accessToken);
      if (record && !forced && tokenFresh(record)) return identified(record, true);
      if (record) {
        const refreshed = await refreshToken(ctx, record, deps, options.signal);
        if (refreshed) {
          writeToken(ctx, refreshed);
          return identified(refreshed, true);
        }
        // Not refreshed, but still good for a while: keep working with it.
        if (!forced && tokenValid(record)) return identified(record, true);
      }
      const state = readState(ctx);
      const root =
        (options.cwd ? gitToplevel(options.cwd) : null) ??
        record?.repositoryRoot ??
        state?.repositoryRoot;
      if (!options.explicit) {
        // A hook process never starts the first check and pauses after a failure.
        if (!root || !(record || state))
          return failure(
            "not_identified",
            "this session has not identified who started it yet",
            RETRY_REMEDY,
          );
        if (state && state.at > Date.now() - BACKGROUND_RETRY_MS) return outcomeFromState(state);
      } else if (state && state.at >= startedAt) {
        // Another process finished an attempt while this one waited.
        return outcomeFromState(state);
      }
      if (!root)
        return failure(
          "repository_missing",
          "this is not a git repository",
          "run it in the repository the session cloned",
        );

      const attempt: Attempt = { root };
      const remember = (outcome: SessionLinkRequired | SessionIdentityFailure) => {
        writeState(ctx, {
          sessionId: ctx.sessionId,
          status: outcome.status,
          code: outcome.status === "failed" ? outcome.code : "github_account_not_linked",
          ...(outcome.status === "failed"
            ? { cause: outcome.cause, remedy: outcome.remedy }
            : {
                githubLogin: outcome.githubLogin,
              }),
          challengeId:
            outcome.status === "link_required" ? outcome.challengeId : attempt.challengeId,
          challengeExpiresAt:
            outcome.status === "link_required"
              ? outcome.challengeExpiresAt
              : attempt.challengeExpiresAt,
          repositoryRoot: root,
          branch: attempt.branch ?? state?.branch,
          baseSha: attempt.baseSha ?? state?.baseSha,
          at: Date.now(),
        });
        return outcome;
      };

      // A check whose push already went out and only waited too long for
      // GitHub's notice can still be verified: poll it again rather than
      // pushing a branch that now exists.
      let challenge: {
        challengeId: string;
        challengeExpiresAt: number;
        repository: string;
        githubLogin?: string;
      };
      if (
        state?.code === "webhook_timeout" &&
        state.challengeId &&
        (state.challengeExpiresAt ?? 0) > Date.now()
      ) {
        attempt.challengeId = state.challengeId;
        attempt.challengeExpiresAt = state.challengeExpiresAt;
        attempt.branch = state.branch;
        attempt.baseSha = state.baseSha;
        challenge = {
          challengeId: state.challengeId,
          challengeExpiresAt: state.challengeExpiresAt ?? 0,
          repository: githubRepositoryFullName(root) ?? "the repository",
        };
      } else if (state?.status === "link_required" && state.challengeId) {
        // Verified already; only the link is missing. Ask again whether it exists.
        attempt.challengeId = state.challengeId;
        attempt.challengeExpiresAt = state.challengeExpiresAt;
        const exchanged = await exchangeChallenge(
          ctx,
          {
            challengeId: state.challengeId,
            challengeExpiresAt: state.challengeExpiresAt ?? 0,
            githubLogin: state.githubLogin,
          },
          root,
          deps,
          options.signal,
        );
        if ("status" in exchanged) return remember(exchanged);
        writeToken(ctx, exchanged);
        return identified(exchanged, false);
      } else if (!options.explicit) {
        // Creating the session branch is for session start and the commands a
        // person runs; a hook process reports what the last attempt found.
        return state
          ? outcomeFromState(state)
          : failure(
              "not_identified",
              "this session has not identified who started it yet",
              RETRY_REMEDY,
            );
      } else {
        const pushed = await challengeAndPush(ctx, root, state, deps, attempt, options.signal);
        if ("status" in pushed) return remember(pushed);
        challenge = pushed;
      }
      const verified = await pollChallenge(
        ctx.apiUrl,
        challenge.challengeId,
        challenge.repository,
        // A hook process waits only briefly for a late notice.
        options.explicit
          ? deps
          : { ...deps, pollBudgetMs: Math.min(deps.pollBudgetMs ?? POLL_BUDGET_MS, 3_000) },
        options.signal,
      );
      if ("status" in verified) return remember(verified);
      const exchanged = await exchangeChallenge(
        ctx,
        { ...challenge, githubLogin: verified.githubLogin },
        root,
        deps,
        options.signal,
      );
      if ("status" in exchanged) return remember(exchanged);
      writeToken(ctx, exchanged);
      return identified(exchanged, false);
    },
    { signal: options.signal, timeoutMs: LOCK_TIMEOUT_MS },
  );
}

/**
 * The member credential for an API request in session identity mode. Never
 * the environment credential: without a member token the request fails
 * (not terminally), so nothing is sent, and nothing is attributed, as anyone.
 */
export async function acquireSessionCredential(
  options: { force?: boolean; signal?: AbortSignal } = {},
  deps: SessionIdentityDependencies = {},
): Promise<MachineCredential> {
  const cached = cachedSessionCredential(deps);
  const fresh = cached?.session !== undefined && Date.now() < cached.session.refreshAfter;
  if (cached && fresh && !options.force) return cached;
  // A hook waits as long as any machine credential request, not for a whole
  // identity check another process is running.
  const signal = options.signal
    ? AbortSignal.any([options.signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
  let outcome: SessionIdentityOutcome;
  try {
    outcome = await ensureSessionIdentity(
      { force: options.force, observedToken: cached?.accessToken, signal },
      deps,
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    if (error instanceof MachineAuthError) throw error;
    throw new MachineAuthError(
      "identity_unavailable",
      "Identifying who started this cloud session is still in progress; retry shortly.",
    );
  }
  if (outcome.status === "ok") return outcome.credential;
  throw new MachineAuthError(
    outcome.status === "link_required" ? "github_account_not_linked" : outcome.code,
    sessionIdentityMessage(outcome),
  );
}

/**
 * Link the GitHub account that pushed a verified challenge to the person
 * signed in with `humanAccessToken`, then take that member's token. The
 * human token is used for this one request and never stored.
 */
export async function linkSessionIdentity(
  challenge: { challengeId: string; challengeExpiresAt: number; githubLogin: string },
  humanAccessToken: string,
  options: { cwd?: string; signal?: AbortSignal } = {},
  deps: SessionIdentityDependencies = {},
): Promise<SessionIdentityOutcome> {
  const context = sessionContext(deps);
  if ("status" in context) return context;
  let answer: ApiAnswer;
  try {
    answer = await sendJson(
      `${context.apiUrl}${SESSION_IDENTITY_ROUTES.link}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${humanAccessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ challengeId: challenge.challengeId }),
        signal: options.signal ?? AbortSignal.timeout(30_000),
      },
      deps.fetch ?? fetch,
    );
  } catch (error) {
    options.signal?.throwIfAborted();
    return environmentFailure(error, context.apiUrl);
  }
  if (answer.status !== 200 || answer.value?.linked !== true) {
    const code = answerError(answer);
    return failure(
      "link_failed",
      `Primitive did not link GitHub account @${challenge.githubLogin}${
        code ? ` (${terminalSafeLine(code).slice(0, 120)})` : ` (HTTP ${answer.status})`
      }`,
      answer.status === 401 || answer.status === 403
        ? "sign in as a member of the organization that owns this environment and run `prim auth link` again"
        : `${NEW_SESSION_REMEDY} and run \`prim auth link\` there as soon as it asks`,
    );
  }
  const linkedLogin = machineString(answer.value.githubLogin, 64)
    ? answer.value.githubLogin
    : challenge.githubLogin;
  const root = options.cwd ? (gitToplevel(options.cwd) ?? undefined) : undefined;
  return withFileLock(
    context.lockPath,
    async (): Promise<SessionIdentityOutcome> => {
      const exchanged = await exchangeChallenge(
        context,
        { ...challenge, githubLogin: linkedLogin },
        root ?? readState(context)?.repositoryRoot,
        deps,
        options.signal,
      );
      if ("status" in exchanged) {
        if (exchanged.status === "link_required")
          return failure(
            "link_failed",
            `Primitive linked GitHub account @${linkedLogin} but still refused this session's token`,
            `${NEW_SESSION_REMEDY}; it should identify you automatically`,
          );
        return exchanged;
      }
      writeToken(context, exchanged);
      return identified(exchanged, false);
    },
    { signal: options.signal, timeoutMs: LOCK_TIMEOUT_MS },
  );
}
