import { CLOUD_REJECTED_CREDENTIALS_REMEDY, isClaudeCloudSession } from "./cloud-env.js";
import { readBoundedJson } from "./workos-connect.js";

export const MACHINE_SCOPES = [
  "cli:read",
  "cli:capture",
  "cli:check",
  "cli:presence",
  "cli:decisions:write",
] as const;

export type MachineConfiguration = {
  issuer: string;
  audience: string;
  developerEnrollment?: boolean;
};
export type MachineIdentity = {
  machineId: string;
  authorizedUserId?: string;
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
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "MachineAuthError";
  }
}

/** OAuth error bodies are untrusted; retain only bounded, standard retry metadata. */
export function machineRetryAt(response: Response, now = Date.now()): number | undefined {
  const value = response.headers.get("Retry-After")?.trim();
  if (!value || value.length > 128) return undefined;
  const timestamp = /^\d+$/u.test(value) ? now + Number(value) * 1000 : Date.parse(value);
  return Number.isSafeInteger(timestamp) && timestamp > now ? timestamp : undefined;
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
  return {
    issuer: record.issuer,
    audience: record.audience,
    ...(record.developer_enrollment === true ? { developerEnrollment: true } : {}),
  };
}

/**
 * A cloud session has no administrator at hand: the person who configured its
 * environment corrects the credentials there, and a session reads them only
 * when it is created.
 */
export function rejectedCredentialsMessage(
  message: string,
  env: NodeJS.ProcessEnv = process.env,
): string {
  return isClaudeCloudSession(env)
    ? `The cloud environment's credentials were rejected. To fix it, ${CLOUD_REJECTED_CREDENTIALS_REMEDY}.`
    : message;
}

export function machineSignal(signal?: AbortSignal): AbortSignal {
  return signal
    ? AbortSignal.any([signal, AbortSignal.timeout(10_000)])
    : AbortSignal.timeout(10_000);
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return "Primitive";
  }
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
      // A cloud VM reaches only the hosts its environment allows, and both of
      // Primitive's are blocked by default: name the one that failed.
      isClaudeCloudSession()
        ? `Machine authentication could not reach ${hostOf(url)}. If this Claude Code cloud environment blocks it, add it to the environment's Allowed domains (Network access: Limited).`
        : "Machine authentication is temporarily unavailable. Check the connection and retry.",
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
  options: { secretInjection?: "network" } = {},
): Promise<MachineTokens> {
  const network = options.secretInjection === "network";
  if (!/^client_[\w-]+$/u.test(clientId) || (!network && !machineString(clientSecret))) {
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
      // With a network secret the agent proxy authenticates the client with
      // HTTP Basic (client_secret_basic); the body carries no credential.
      body: new URLSearchParams(
        network
          ? { grant_type: "client_credentials" }
          : { grant_type: "client_credentials", client_id: clientId, client_secret: clientSecret },
      ),
    },
    fetchImpl,
  );
  if (!response.ok) {
    // Never echo OAuth response bodies: providers may reflect submitted secrets.
    const terminal = response.status === 400 || response.status === 401 || response.status === 403;
    throw new MachineAuthError(
      terminal ? "machine_credentials_rejected" : "token_service_unavailable",
      terminal
        ? network
          ? `The token service rejected the request. Check the cloud environment's network secret for ${new URL(configuration.issuer).hostname}: username = the client ID, password = the client secret.`
          : rejectedCredentialsMessage(
              "Machine credentials were rejected. Ask your administrator to rotate or enable them.",
            )
        : "The machine token service is temporarily unavailable.",
      terminal,
      terminal ? undefined : machineRetryAt(response),
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
  // A well-formed token for another client: the caller may know why.
  if (
    claims.iss === configuration.issuer &&
    claims.aud === configuration.audience &&
    (claims.sub !== clientId || claims.client_id !== clientId)
  )
    throw new MachineAuthError(
      "token_client_mismatch",
      "The token service issued a token for another machine client.",
    );
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
    ![2, 3].includes(data.organizationBindingVersion as number) ||
    (data.organizationBindingVersion === 3
      ? !machineString(principal.authorizedUserId, 256)
      : principal.authorizedUserId !== undefined) ||
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
    ...(data.organizationBindingVersion === 3
      ? { authorizedUserId: principal.authorizedUserId as string }
      : {}),
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

/**
 * Read the API's answer to an identity check whose request carried no token:
 * in network-token mode the cloud environment's proxy attaches it. A refusal
 * therefore points at that proxy's network secret, not at a credential prim
 * holds, and a verified identity for another client means the secret's
 * client ID and PRIM_M2M_CLIENT_ID differ.
 */
export function parseInjectedMachineIdentity(
  status: number,
  value: unknown,
  apiUrl: string,
  clientId: string,
): MachineIdentity {
  const rejected = () =>
    new MachineAuthError(
      "network_token_rejected",
      `Primitive did not accept this machine: the cloud environment's proxy attached no token it accepts, or the installation was revoked. Check the environment's OAuth 2.0 client credentials network secret: allowed website ${new URL(apiUrl).hostname}, the client ID (${clientId}), the client secret, and the token URL.`,
      true,
    );
  if (status === 401 || status === 403) throw rejected();
  if (status < 200 || status > 299)
    throw new MachineAuthError(
      "verification_unavailable",
      "Machine verification is temporarily unavailable.",
    );
  let data: Record<string, unknown>;
  try {
    data = machineRecord(value);
  } catch {
    throw new MachineAuthError("invalid_response", "Invalid machine authentication response.");
  }
  if (data.authenticated !== true) throw rejected();
  const principal =
    data.principal && typeof data.principal === "object"
      ? (data.principal as Record<string, unknown>)
      : {};
  if (
    principal.kind === "machine" &&
    typeof principal.clientId === "string" &&
    principal.clientId !== clientId
  )
    throw new MachineAuthError(
      "network_secret_mismatch",
      `The proxy's token belongs to another machine. Check that the network secret's client ID equals PRIM_M2M_CLIENT_ID (${clientId}).`,
      true,
    );
  return parseMachineIdentity(data, clientId);
}

/** Verify the identity the cloud environment's proxy authenticates this machine as. */
export async function verifyInjectedMachineIdentity(
  apiUrl: string,
  clientId: string,
  signal?: AbortSignal,
  fetchImpl: typeof fetch = fetch,
): Promise<MachineIdentity> {
  const response = await fetchMachine(
    `${machineApiUrl(apiUrl)}/api/cli/auth/status`,
    { redirect: "error", signal: machineSignal(signal) },
    fetchImpl,
  );
  const value = response.ok ? await readMachineJson(response, 16 * 1024) : undefined;
  return parseInjectedMachineIdentity(response.status, value, apiUrl, clientId);
}
