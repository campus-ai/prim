import { getSiteUrl } from "../client.js";
import {
  CLOUD_CREDENTIALS_REMEDY,
  cloudDomainEditNote,
  cloudProxyRouting,
  isClaudeCloudSession,
} from "./cloud-env.js";
import { resolveStoredCredential } from "./credentials.js";
import { type EgressReport, probeEgress } from "./egress-probe.js";
import { githubRepositoryFullName, originIdentifiesRepository } from "./git.js";
import {
  NETWORK_TOKEN_AUTH,
  hasMachineConfiguration,
  probeMachineEgress,
} from "./machine-credentials.js";
import { MachineAuthError } from "./machine-protocol.js";

export { CLOUD_CREDENTIALS_REMEDY, isClaudeCloudSession };

/** The sign-in host machine credentials exchange tokens with in production. */
export const PRODUCTION_SIGN_IN_HOST = "signin.getprimitive.ai";

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

/**
 * The hosts a cloud environment's network allowlist must include for prim.
 * With a proxy-held token (network-token) prim never contacts the sign-in
 * service: the proxy does, from outside the VM.
 */
export function cloudAllowedDomains(
  siteUrl: string = getSiteUrl(),
  signInHost: string = PRODUCTION_SIGN_IN_HOST,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const api = hostOf(siteUrl, "api.getprimitive.ai");
  return env.PRIM_M2M_CLIENT_AUTH === NETWORK_TOKEN_AUTH ? [api] : [...new Set([api, signInHost])];
}

export function cloudEgressRemedy(
  siteUrl?: string,
  signInHost?: string,
  env?: NodeJS.ProcessEnv,
): string {
  return `add ${cloudAllowedDomains(siteUrl, signInHost, env).join(" and ")} to the cloud environment's Allowed domains (Network access: Limited)${cloudDomainEditNote(env)}`;
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
 *
 * The hosts are probed over the route prim's requests take. Where they go
 * through the token broker and the environment's proxy (see
 * cloudProxyRouting), the broker probes: this process's own connections
 * resolve only the hosts allowed when the session was created, so a probe
 * from here would report a host as blocked after the user had allowed it.
 * An injected `fetch` stands in for the network and is used as given.
 */
export async function diagnoseCloudSession(
  options: {
    env?: NodeJS.ProcessEnv;
    fetch?: typeof fetch;
    /** Stands in for the broker's probe. */
    brokerProbe?: (deps: { env: NodeJS.ProcessEnv }) => Promise<EgressReport>;
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
  if (options.cwd !== undefined && !githubRepositoryFullName(options.cwd))
    return `${prefix}: ${repositoryIdentityRemedy(options.cwd)}.`;

  const siteUrl = options.siteUrl ?? getSiteUrl();
  const unconnected = `${prefix}: the repository could not be connected. Run \`prim setup --cloud\` for details.`;
  let egress: EgressReport;
  if (!options.fetch && cloudProxyRouting(env)) {
    try {
      egress = await (options.brokerProbe ?? probeMachineEgress)({ env });
    } catch {
      // No broker, no finding: a probe from this process would not say what
      // prim can reach, and cloud setup reports the broker's own failure.
      return unconnected;
    }
  } else
    egress = await probeEgress(
      siteUrl,
      machine && env.PRIM_M2M_CLIENT_AUTH !== NETWORK_TOKEN_AUTH,
      options.fetch ?? fetch,
    );
  if (egress.api !== "ok")
    return `${prefix}: ${unreachable("Primitive", egress.api, cloudEgressRemedy(siteUrl, undefined, env))}`;
  if (egress.signIn && egress.signIn.result !== "ok")
    return `${prefix}: ${unreachable("Primitive's sign-in service", egress.signIn.result, cloudEgressRemedy(siteUrl, egress.signIn.host, env))}`;
  return unconnected;
}
