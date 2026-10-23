import { getClient } from "../client.js";
import {
  type DemoStatusResponse,
  isDemoCompleteRequest,
  isDemoResolveRequest,
  isDemoRunRequest,
  isDemoStartRequest,
  isDemoStatusResponse,
} from "../contract/cli-http-v1.js";

export async function demoApi(
  action: "start" | "check" | "resolve" | "complete" | "skip",
  body: unknown,
): Promise<DemoStatusResponse> {
  const valid =
    action === "start"
      ? isDemoStartRequest
      : action === "resolve"
        ? isDemoResolveRequest
        : action === "complete"
          ? isDemoCompleteRequest
          : isDemoRunRequest;
  if (!valid(body)) throw new Error("Invalid demo request");
  return validate(
    await getClient().post(`/api/cli/demo/${action}`, body, {
      signal: AbortSignal.timeout(20_000),
    }),
  );
}
export async function demoStatus(runId: string): Promise<DemoStatusResponse> {
  if (!/^[a-zA-Z0-9]{1,64}$/u.test(runId)) throw new Error("Invalid server demo identity");
  return validate(
    await getClient().get(`/api/cli/demo/${runId}`, { signal: AbortSignal.timeout(20_000) }),
  );
}
function validate(value: unknown): DemoStatusResponse {
  if (!isDemoStatusResponse(value))
    throw new Error("Invalid demo response; no sample write applied");
  return value;
}
