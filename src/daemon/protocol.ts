import { type DaemonPrincipal, isDaemonPrincipal } from "./principal.js";

export const DAEMON_JSON_REQUEST_MAX_BYTES = 64 * 1024;
export const DAEMON_JSON_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
export const DAEMON_SOCKET_IDLE_TIMEOUT_MS = 2_000;

export interface DaemonRequestEnvelope {
  id: number;
  method: string;
  params?: Record<string, unknown>;
  caller?: DaemonPrincipal;
}

export interface DaemonResponseEnvelope {
  id: number;
  ok: boolean;
  result?: unknown;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseDaemonRequestEnvelope(value: unknown): DaemonRequestEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  if (!(typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id >= 0)) {
    return undefined;
  }
  if (typeof value.method !== "string" || value.method.length === 0 || value.method.length > 100) {
    return undefined;
  }
  if (value.params !== undefined && !isRecord(value.params)) return undefined;
  if (value.caller !== undefined && !isDaemonPrincipal(value.caller)) return undefined;
  return {
    id: value.id,
    method: value.method,
    ...(value.params === undefined ? {} : { params: value.params }),
    ...(value.caller === undefined ? {} : { caller: value.caller }),
  };
}

export function parseDaemonResponseEnvelope(value: unknown): DaemonResponseEnvelope | undefined {
  if (!isRecord(value)) return undefined;
  if (!(typeof value.id === "number" && Number.isSafeInteger(value.id) && value.id >= 0)) {
    return undefined;
  }
  if (typeof value.ok !== "boolean") return undefined;
  if (value.error !== undefined && typeof value.error !== "string") return undefined;
  return {
    id: value.id,
    ok: value.ok,
    ...(value.result === undefined ? {} : { result: value.result }),
    ...(value.error === undefined ? {} : { error: value.error }),
  };
}
