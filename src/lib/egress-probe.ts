import { machineApiUrl } from "./machine-protocol.js";
import { readBoundedJson } from "./workos-connect.js";

const PROBE_TIMEOUT_MS = 3_000;

/**
 * What the probing process can reach of Primitive. Each result is "ok" or
 * what the failure means: "blocked", "timeout", or the failure's own code.
 */
export type EgressReport = {
  api: string;
  /** The sign-in service the API names, when it was asked for. */
  signIn?: { host: string; result: string };
};

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

/**
 * Ask the API for its machine-authentication configuration and, when
 * `signIn` is set, the sign-in service that configuration names. The answer
 * describes the process that runs this and the route its `fetch` takes, so
 * it must run in the process that makes prim's requests: the token broker
 * where prim sends them through the cloud environment's proxy.
 */
export async function probeEgress(
  apiUrl: string,
  signIn: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<EgressReport> {
  const config = await probe(`${apiUrl.replace(/\/+$/u, "")}/api/cli/auth/m2m/config`, fetchImpl);
  if (!config.ok) return { api: config.failure };
  if (!signIn) {
    await config.response.body?.cancel().catch(() => undefined);
    return { api: "ok" };
  }
  let issuer: string | undefined;
  try {
    const body = (await readBoundedJson(config.response, 16 * 1024)) as { issuer?: unknown };
    issuer = typeof body.issuer === "string" ? machineApiUrl(body.issuer) : undefined;
  } catch {
    issuer = undefined;
  }
  if (!issuer) return { api: "ok" };
  const answer = await probe(issuer, fetchImpl);
  if (answer.ok) await answer.response.body?.cancel().catch(() => undefined);
  return {
    api: "ok",
    signIn: { host: new URL(issuer).hostname, result: answer.ok ? "ok" : answer.failure },
  };
}
