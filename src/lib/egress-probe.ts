import { machineApiUrl } from "./machine-protocol.js";
import { tunnelCheckedFetch } from "./proxy-tunnel.js";
import { readBoundedJson } from "./workos-connect.js";

const PROBE_TIMEOUT_MS = 3_000;

/**
 * What the probing process can reach of Primitive. Each result is "ok" or
 * what the failure means: "blocked", "timeout", or the failure's own code,
 * which begins PROXY_ when the proxy itself failed (see checkTunnel).
 */
export type EgressReport = {
  api: string;
  /** The sign-in service the API names, when it was asked for. */
  signIn?: { host: string; result: string };
};

type ProbeResult = { ok: true; response: Response } | { ok: false; failure: string };

/**
 * Name what a failed probe means. Only two things are a block: DNS that will
 * not resolve the host, and the proxy answering a CONNECT for it with 403
 * (see checkTunnel, which reads the proxy's status; the text of a failed
 * `fetch` does not carry it). Any other answer from the proxy, or none, is
 * the proxy failing and keeps its PROXY_ code.
 */
function probeFailure(error: unknown): "blocked" | "timeout" | string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") return "timeout";
  const cause = (error as { cause?: { code?: unknown } } | undefined)?.cause;
  const code = typeof cause?.code === "string" ? cause.code : "";
  if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "PROXY_BLOCKED") return "blocked";
  if (code === "PROXY_TIMEOUT") return "timeout";
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
 * where prim sends them through the cloud environment's proxy. Unless a
 * `fetch` is given, a routed process asks the proxy first (tunnelCheckedFetch).
 */
export async function probeEgress(
  apiUrl: string,
  signIn: boolean,
  fetchImpl: typeof fetch = tunnelCheckedFetch(),
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
