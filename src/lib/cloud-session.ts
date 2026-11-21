import { getSiteUrl } from "../client.js";
import { resolveAuthCredential } from "./credentials.js";
import { hasMachineConfiguration } from "./machine-credentials.js";

/** The sign-in host machine credentials exchange tokens with in production. */
export const PRODUCTION_SIGN_IN_HOST = "signin.getprimitive.ai";

const PROBE_TIMEOUT_MS = 3_000;

export const CLOUD_CREDENTIALS_REMEDY =
  'set PRIM_M2M_CLIENT_ID and PRIM_M2M_CLIENT_SECRET in the cloud environment\'s variables; mint them on your own machine with `prim auth enroll --new-installation "Claude Code cloud" --print-env`';

export function isClaudeCloudSession(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.CLAUDE_CODE_REMOTE === "true";
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

async function reachable(url: string, fetchImpl: typeof fetch): Promise<boolean> {
  try {
    await fetchImpl(url, { redirect: "manual", signal: AbortSignal.timeout(PROBE_TIMEOUT_MS) });
    return true;
  } catch {
    // A blocked host fails before any response: DNS refusal or a refused tunnel.
    return false;
  }
}

/**
 * Explain why prim could not connect a Claude Code cloud session, or return
 * undefined outside one. A cloud VM blocks Primitive's hosts by default and
 * starts without credentials; both otherwise fail open silently, which reads
 * as prim working when nothing reaches Primitive at all.
 */
export async function diagnoseCloudSession(
  options: { env?: NodeJS.ProcessEnv; fetch?: typeof fetch; siteUrl?: string } = {},
): Promise<string | undefined> {
  const env = options.env ?? process.env;
  if (!isClaudeCloudSession(env)) return undefined;
  const prefix = "Primitive is not connected in this Claude Code cloud session";
  let machine: boolean;
  try {
    machine = hasMachineConfiguration({ env });
  } catch {
    return `${prefix}: its machine credentials are incomplete. To fix it, ${CLOUD_CREDENTIALS_REMEDY}.`;
  }
  if (!machine && !resolveAuthCredential({ env }))
    return `${prefix}: it has no credentials. To fix it, ${CLOUD_CREDENTIALS_REMEDY}.`;

  const fetchImpl = options.fetch ?? fetch;
  const siteUrl = options.siteUrl ?? getSiteUrl();
  const configUrl = `${siteUrl.replace(/\/+$/u, "")}/api/cli/auth/m2m/config`;
  if (!(await reachable(configUrl, fetchImpl)))
    return `${prefix}: this environment cannot reach Primitive. To fix it, ${cloudEgressRemedy(siteUrl)}.`;
  if (machine) {
    let issuer: string | undefined;
    try {
      const response = await fetchImpl(configUrl, {
        signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      });
      const body = (await response.json()) as { issuer?: unknown };
      issuer = typeof body.issuer === "string" ? body.issuer : undefined;
    } catch {
      issuer = undefined;
    }
    if (issuer && !(await reachable(issuer, fetchImpl)))
      return `${prefix}: this environment cannot reach Primitive's sign-in service. To fix it, ${cloudEgressRemedy(siteUrl, hostOf(issuer, PRODUCTION_SIGN_IN_HOST))}.`;
  }
  return `${prefix}: the repository could not be connected. Run \`prim setup --cloud\` for details.`;
}
