import { createHash } from "node:crypto";
import { decodeJwtPayload, resolveAuthCredential } from "../lib/credentials.js";
import { hasMachineConfiguration, machineContext } from "../lib/machine-credentials.js";

const PRINCIPAL_COMPONENT_MAX_LENGTH = 512;
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/;

/**
 * Non-secret proof of the credential generation and tenant a socket caller is
 * currently using. The raw bearer never crosses the local socket.
 */
export interface DaemonPrincipal {
  principalId: string;
  organizationId: string;
  credentialFingerprint: string;
}

function boundedClaim(value: unknown): string | undefined {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= PRINCIPAL_COMPONENT_MAX_LENGTH
    ? value
    : undefined;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** Track credential rotation even when an opaque compatibility token has no JWT claims. */
export function resolveDaemonCredentialKey(
  token = resolveAuthCredential()?.token,
): string | undefined {
  if (hasMachineConfiguration()) {
    const machine = machineContext();
    return machine
      ? `${machine.generation}${machine.authorizedUserId ? `\0${machine.authorizedUserId}` : ""}`
      : undefined;
  }
  return token ? sha256(token) : undefined;
}

/** Resolve the current caller principal without trusting unsigned claims alone. */
export function resolveDaemonPrincipal(
  token = resolveAuthCredential()?.token,
): DaemonPrincipal | undefined {
  if (hasMachineConfiguration()) {
    const machine = machineContext();
    return machine
      ? {
          principalId: sha256(
            `${machine.issuer}\0${machine.clientId}${machine.authorizedUserId ? `\0${machine.authorizedUserId}` : ""}`,
          ),
          organizationId: machine.workosOrganizationId,
          credentialFingerprint: sha256(machine.generation),
        }
      : undefined;
  }
  if (!token) return undefined;
  const payload = decodeJwtPayload(token);
  const subject = boundedClaim(payload?.sub);
  const organizationId = boundedClaim(payload?.org_id);
  if (!(subject && organizationId)) return undefined;

  const issuer = boundedClaim(payload?.iss) ?? "unknown-issuer";
  return {
    principalId: sha256(`${issuer}\0${subject}`),
    organizationId,
    credentialFingerprint: sha256(token),
  };
}

export function isDaemonPrincipal(value: unknown): value is DaemonPrincipal {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.principalId === "string" &&
    SHA256_HEX_PATTERN.test(candidate.principalId) &&
    typeof candidate.organizationId === "string" &&
    candidate.organizationId.length > 0 &&
    candidate.organizationId.length <= PRINCIPAL_COMPONENT_MAX_LENGTH &&
    typeof candidate.credentialFingerprint === "string" &&
    SHA256_HEX_PATTERN.test(candidate.credentialFingerprint)
  );
}

export function daemonPrincipalsMatch(
  caller: DaemonPrincipal | undefined,
  daemon: DaemonPrincipal | undefined,
): boolean {
  return (
    caller !== undefined &&
    daemon !== undefined &&
    caller.principalId === daemon.principalId &&
    caller.organizationId === daemon.organizationId &&
    caller.credentialFingerprint === daemon.credentialFingerprint
  );
}
