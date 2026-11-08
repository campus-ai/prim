import { readBoundedJson } from "./workos-connect.js";

export const MACHINE_SCOPES = [
  "cli:read",
  "cli:capture",
  "cli:check",
  "cli:presence",
  "cli:decisions:write",
] as const;

export type MachineConfiguration = { issuer: string; audience: string };
export type MachineIdentity = {
  machineId: string;
  clientId: string;
  organizationId: string;
  workosOrganizationId: string;
  displayName: string;
  scopes: string[];
};
export type MachineTokens = { accessToken: string; expiresAt: number };

export class MachineAuthError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly terminal = false,
  ) {
    super(message);
    this.name = "MachineAuthError";
  }
}

export function machineString(value: unknown, maximum = 4096): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

export function machineRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new MachineAuthError("invalid_response", "Invalid machine authentication response.");
  }
  return value as Record<string, unknown>;
}

export function machineApiUrl(value: string): string {
  const url = new URL(value);
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !(local && url.protocol === "http:")) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new MachineAuthError("invalid_configuration", "The API URL must be an HTTPS origin.");
  }
  return url.origin;
}

export function parseMachineConfiguration(value: unknown): MachineConfiguration {
  const record = machineRecord(value);
  if (
    record.protocol_version !== 1 ||
    !machineString(record.issuer, 2048) ||
    !machineString(record.audience, 256) ||
    !/^client_[\w-]+$/u.test(record.audience)
  ) {
    throw new MachineAuthError("invalid_configuration", "Invalid M2M discovery configuration.");
  }
  const issuer = new URL(record.issuer);
  if (issuer.protocol !== "https:" || issuer.origin !== record.issuer) {
    throw new MachineAuthError(
      "invalid_configuration",
      "The WorkOS issuer must be an HTTPS origin.",
    );
  }
  return { issuer: record.issuer, audience: record.audience };
}

export function machineSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
}

async function fetchMachine(
  url: string,
  options: RequestInit,
  fetchImpl: typeof fetch,
): Promise<Response> {
  try {
    return await fetchImpl(url, options);
  } catch {
    options.signal?.throwIfAborted();
    throw new MachineAuthError(
      "authentication_unavailable",
      "Machine authentication is temporarily unavailable. Check the connection and retry.",
    );
  }
}

async function readMachineJson(response: Response, maximumBytes: number): Promise<unknown> {
  try {
    return await readBoundedJson(response, maximumBytes);
  } catch {
    throw new MachineAuthError("invalid_response", "Invalid machine authentication response.");
  }
}

export async function discoverMachineConfiguration(
  apiUrl: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<MachineConfiguration> {
  const response = await fetchMachine(
    `${machineApiUrl(apiUrl)}/api/cli/auth/m2m/config`,
    {
      signal: machineSignal(signal),
      redirect: "error",
    },
    fetchImpl,
  );
  if (!response.ok)
    throw new MachineAuthError(
      response.status === 404 ? "server_upgrade_required" : "discovery_unavailable",
      response.status === 404
        ? "This server does not support machine authentication yet."
        : "Machine authentication discovery is unavailable.",
    );
  return parseMachineConfiguration(await readMachineJson(response, 16 * 1024));
}

export async function exchangeMachineCredentials(
  configuration: MachineConfiguration,
  clientId: string,
  clientSecret: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<MachineTokens> {
  if (!/^client_[\w-]+$/u.test(clientId) || !machineString(clientSecret)) {
    throw new MachineAuthError(
      "invalid_credentials",
      "A machine client ID and secret are required.",
      true,
    );
  }
  const response = await fetchMachine(
    `${configuration.issuer}/oauth2/token`,
    {
      method: "POST",
      redirect: "error",
      signal: machineSignal(signal),
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
      }),
    },
    fetchImpl,
  );
  if (!response.ok) {
    // Never echo OAuth response bodies: providers may reflect submitted secrets.
    const terminal = response.status === 400 || response.status === 401 || response.status === 403;
    throw new MachineAuthError(
      terminal ? "machine_credentials_rejected" : "token_service_unavailable",
      terminal
        ? "Machine credentials were rejected. Ask your administrator to rotate or enable them."
        : "The machine token service is temporarily unavailable.",
      terminal,
    );
  }
  const data = machineRecord(await readMachineJson(response, 64 * 1024));
  if (
    !machineString(data.access_token, 60 * 1024) ||
    typeof data.token_type !== "string" ||
    data.token_type.toLowerCase() !== "bearer" ||
    !Number.isSafeInteger(data.expires_in) ||
    (data.expires_in as number) <= 0 ||
    (data.expires_in as number) > 86400
  ) {
    throw new MachineAuthError(
      "invalid_response",
      "The token service returned an invalid access token.",
    );
  }
  // This is a consistency check, not signature verification. The API verifies the JWT.
  let claims: Record<string, unknown>;
  try {
    claims = machineRecord(
      JSON.parse(Buffer.from(data.access_token.split(".")[1] ?? "", "base64url").toString("utf8")),
    );
  } catch {
    throw new MachineAuthError("invalid_response", "The token service returned an invalid JWT.");
  }
  if (
    claims.iss !== configuration.issuer ||
    claims.aud !== configuration.audience ||
    claims.sub !== clientId ||
    claims.client_id !== clientId ||
    !machineString(claims.org_id, 256) ||
    typeof claims.exp !== "number" ||
    !Number.isFinite(claims.exp) ||
    claims.exp * 1000 <= Date.now()
  ) {
    throw new MachineAuthError(
      "token_identity_mismatch",
      "The token does not match the configured machine and deployment.",
    );
  }
  return {
    accessToken: data.access_token,
    expiresAt: Math.min(Date.now() + (data.expires_in as number) * 1000, claims.exp * 1000),
  };
}

export function parseMachineIdentity(value: unknown, clientId: string): MachineIdentity {
  const data = machineRecord(value);
  const principal = machineRecord(data.principal);
  if (
    data.authenticated !== true ||
    data.captureAuthorityKind !== "workos_m2m" ||
    data.organizationBindingVersion !== 2 ||
    principal.kind !== "machine" ||
    principal.clientId !== clientId ||
    !machineString(principal.machineId, 256) ||
    !machineString(principal.displayName, 256) ||
    !machineString(data.organizationId, 256) ||
    !machineString(data.workosOrganizationId, 256) ||
    !Array.isArray(principal.scopes) ||
    !principal.scopes.every((scope) => machineString(scope, 128))
  ) {
    throw new MachineAuthError(
      "machine_identity_rejected",
      "The API did not verify a machine identity.",
      true,
    );
  }
  return {
    machineId: principal.machineId,
    clientId,
    displayName: principal.displayName,
    organizationId: data.organizationId,
    workosOrganizationId: data.workosOrganizationId,
    scopes: principal.scopes as string[],
  };
}

export async function verifyMachineIdentity(
  apiUrl: string,
  accessToken: string,
  clientId: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<MachineIdentity> {
  const response = await fetchMachine(
    `${machineApiUrl(apiUrl)}/api/cli/auth/status`,
    {
      headers: { Authorization: `Bearer ${accessToken}` },
      redirect: "error",
      signal: machineSignal(signal),
    },
    fetchImpl,
  );
  if (!response.ok) {
    const terminal = response.status === 401 || response.status === 403;
    throw new MachineAuthError(
      terminal ? "machine_access_rejected" : "verification_unavailable",
      terminal
        ? "The API rejected this machine. Ask your administrator to check its registration and scopes."
        : "Machine verification is temporarily unavailable.",
      terminal,
    );
  }
  return parseMachineIdentity(await readMachineJson(response, 16 * 1024), clientId);
}
