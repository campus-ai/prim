import { getSiteUrl } from "../client.js";
import { CLOUD_CREDENTIALS_REMEDY, isClaudeCloudSession } from "./cloud-env.js";
import { resolveStoredCredential } from "./credentials.js";
import { githubRepositoryFullName, originIdentifiesRepository } from "./git.js";
import { hasMachineConfiguration, networkSecretRoutingProblem } from "./machine-credentials.js";
import { MachineAuthError, machineApiUrl } from "./machine-protocol.js";

export { CLOUD_CREDENTIALS_REMEDY, isClaudeCloudSession };

/** The sign-in host machine credentials exchange tokens with in production. */
export const PRODUCTION_SIGN_IN_HOST = "signin.getprimitive.ai";

const PROBE_TIMEOUT_MS = 3_000;

/**
 * Why a checkout names no GitHub repository, and the fix. A declaration only
 * counts where origin cannot identify the repository (a Claude Code cloud
 * bundle upload has no origin), so suggest it only there.
 */
export function repositoryIdentityRemedy(root: string): string {
  return originIdentifiesRepository(root)
    ? "this checkout's origin is not a GitHub repository in owner/name form; Primitive connects GitHub repositories only"
    : "this checkout does not identify its GitHub repository. Commit the repository declaration: run `prim claude install --scope project` in a clone whose origin is on GitHub, which records PRIM_REPOSITORY in .claude/settings.json";
}

function hostOf(url: string, fallback: string): string {
  try {
    return new URL(url).hostname || fallback;
  } catch {
    return fallback;
  }
}

/** The hosts a cloud environment's network allowlist must include for prim. */
export function cloudAllowedDomains(
  siteUrl: string = getSiteUrl(),
  signInHost: string = PRODUCTION_SIGN_IN_HOST,
): string[] {
  return [...new Set([hostOf(siteUrl, "api.getprimitive.ai"), signInHost])];
}

export function cloudEgressRemedy(siteUrl?: string, signInHost?: string): string {
  return `add ${cloudAllowedDomains(siteUrl, signInHost).join(" and ")} to the cloud environment's Allowed domains (Network access: Limited)`;
}

type ProbeResult = { ok: true; response: Response } | { ok: false; failure: string };

/** Name what a failed probe means; only DNS refusal or a refused tunnel is a block. */
function probeFailure(error: unknown): "blocked" | "timeout" | string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const cause = (error as { cause?: { code?: unknown; message?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  const message = typeof cause?.message === "string" ? cause.message : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN") return "blocked";
  // A refused CONNECT surfaces as a cancelled request or a 403 tunnel answer;
  // a proxy's own 5xx is an outage, not the allowlist.
  if (/cancel|tunnel|\(403\)/iu.test(message) && !/\(5\d\d\)/u.test(message)) return "blocked";
  return code || "network error";
}

async function probe(url: string, fetchImpl: typeof fetch): Promise<ProbeResult> {
  try {
    const response = await fetchImpl(url, {
      redirect: "manual",
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    return { ok: true, response };
  } catch (error) {
    return { ok: false, failure: probeFailure(error) };
  }
}

function unreachable(what: string, failure: string, remedy: string): string {
  if (failure === "blocked") return `this environment cannot reach ${what}. To fix it, ${remedy}.`;
  if (failure === "timeout")
    return `${what} did not answer in time. If this persists, check that you ${remedy.replace(/^add /u, "added ")}.`;
  return `${what} could not be reached (${failure}). Check the environment's network access: ${remedy}.`;
}

/**
 * Explain why prim could not connect a Claude Code cloud session, or return
 * undefined outside one. A cloud VM blocks Primitive's hosts by default and
 * starts without credentials; both otherwise fail open silently, which reads
 * as prim working when nothing reaches Primitive at all. Checks that need no
 * network run first.
 */
export async function diagnoseCloudSession(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    siteUrl?: string;
    cwd?: string;
  } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (!isClaudeCloudSession(env)) return undefined;
  const prefix = "Primitive is not connected in this Claude Code cloud session";
  let machine: boolean;
  try {
    machine = hasMachineConfiguration({ env });
  } catch (error) {
    // Conflicting credentials are fixed by removing one, not by setting more.
    // Conflicting or network-secret credentials are fixed as their own message
    // says; the generic "set the ID and secret" would contradict it.
    if (
      error instanceof MachineAuthError &&
      (error.code === "conflicting_credentials" || env.PRIM_M2M_CLIENT_AUTH !== undefined)
    )
      return `${prefix}: ${error.message}`;
    return `${prefix}: ${error instanceof MachineAuthError ? error.message : "its machine credentials are incomplete."} To fix it, ${CLOUD_CREDENTIALS_REMEDY}.`;
  }
  if (!machine && !resolveStoredCredential(env))
    return `${prefix}: it has no credentials. To fix it, ${CLOUD_CREDENTIALS_REMEDY}.`;
  const routing = networkSecretRoutingProblem(env);
  if (routing) return `${prefix}: ${routing}`;
  if (options.cwd !== undefined && !githubRepositoryFullName(options.cwd))
    return `${prefix}: ${repositoryIdentityRemedy(options.cwd)}.`;

  const fetchImpl = options.fetch ?? fetch;
  const siteUrl = options.siteUrl ?? getSiteUrl();
  const config = await probe(`${siteUrl.replace(/\/+$/u, "")}/api/cli/auth/m2m/config`, fetchImpl);
  if (!config.ok)
    return `${prefix}: ${unreachable("Primitive", config.failure, cloudEgressRemedy(siteUrl))}`;
  if (machine) {
    let issuer: string | undefined;
    try {
      const body = (await config.response.json()) as { issuer?: unknown };
      issuer = typeof body.issuer === "string" ? machineApiUrl(body.issuer) : undefined;
    } catch {
      issuer = undefined;
    }
    if (issuer) {
      const signIn = await probe(issuer, fetchImpl);
      if (!signIn.ok)
        return `${prefix}: ${unreachable("Primitive's sign-in service", signIn.failure, cloudEgressRemedy(siteUrl, hostOf(issuer, PRODUCTION_SIGN_IN_HOST)))}`;
    }
  }
  return `${prefix}: the repository could not be connected. Run \`prim setup --cloud\` for details.`;
}
