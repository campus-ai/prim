import { afterEach, describe, expect, it, vi } from "vitest";
const machine = vi.hoisted(() => ({
  context: undefined as
    | undefined
    | {
        issuer: string;
        clientId: string;
        workosOrganizationId: string;
        generation: string;
        authorizedUserId?: string;
      },
}));
vi.mock("../lib/machine-credentials.js", () => ({
  hasMachineConfiguration: () => Boolean(machine.context),
  machineContext: () => machine.context,
  cachedMachineCredential: () => undefined,
}));
afterEach(() => {
  machine.context = undefined;
});
import {
  daemonPrincipalsMatch,
  isDaemonPrincipal,
  resolveDaemonCredentialKey,
  resolveDaemonPrincipal,
} from "./principal.js";

function jwt(payload: Record<string, unknown>): string {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature",
  ].join(".");
}

describe("daemon principals", () => {
  it("invalidates cached and socket authority when a machine's delegated user changes", () => {
    machine.context = {
      issuer: "https://issuer.test",
      clientId: "client_laptop",
      workosOrganizationId: "org_1",
      generation: "unchanged-secret-generation",
      authorizedUserId: "user_alex",
    };
    const alex = resolveDaemonPrincipal();
    const key = resolveDaemonCredentialKey();
    machine.context.authorizedUserId = "user_sam";
    expect(daemonPrincipalsMatch(alex, resolveDaemonPrincipal())).toBe(false);
    expect(resolveDaemonCredentialKey()).not.toBe(key);
    machine.context.authorizedUserId = undefined;
    expect(daemonPrincipalsMatch(alex, resolveDaemonPrincipal())).toBe(false);
  });
  it("derives a non-secret generation-bound principal from a JWT", () => {
    const token = jwt({ iss: "https://issuer.test", sub: "user_1", org_id: "org_1" });
    const principal = resolveDaemonPrincipal(token);

    expect(principal).toMatchObject({ organizationId: "org_1" });
    expect(principal?.principalId).toMatch(/^[a-f0-9]{64}$/);
    expect(principal?.credentialFingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(principal)).not.toContain(token);
    expect(isDaemonPrincipal(principal)).toBe(true);
  });

  it("fails closed for opaque credentials and incomplete JWT claims", () => {
    expect(resolveDaemonPrincipal("prim_pat_opaque")).toBeUndefined();
    expect(resolveDaemonCredentialKey("prim_pat_opaque")).toMatch(/^[a-f0-9]{64}$/);
    expect(resolveDaemonPrincipal(jwt({ sub: "user_1" }))).toBeUndefined();
    expect(resolveDaemonPrincipal(jwt({ org_id: "org_1" }))).toBeUndefined();
  });

  it("matches the exact user, tenant, and credential generation", () => {
    const first = resolveDaemonPrincipal(
      jwt({ iss: "https://issuer.test", sub: "user_1", org_id: "org_1", gen: 1 }),
    );
    const same = first ? { ...first } : undefined;
    const rotated = resolveDaemonPrincipal(
      jwt({ iss: "https://issuer.test", sub: "user_1", org_id: "org_1", gen: 2 }),
    );
    const otherOrg = resolveDaemonPrincipal(
      jwt({ iss: "https://issuer.test", sub: "user_1", org_id: "org_2", gen: 1 }),
    );

    expect(daemonPrincipalsMatch(first, same)).toBe(true);
    expect(daemonPrincipalsMatch(first, rotated)).toBe(false);
    expect(daemonPrincipalsMatch(first, otherOrg)).toBe(false);
    expect(daemonPrincipalsMatch(first, undefined)).toBe(false);
  });

  it("rejects malformed envelope principals", () => {
    expect(
      isDaemonPrincipal({
        principalId: "a".repeat(64),
        organizationId: "org_1",
        credentialFingerprint: "b".repeat(64),
      }),
    ).toBe(true);
    expect(
      isDaemonPrincipal({
        principalId: "not-a-hash",
        organizationId: "org_1",
        credentialFingerprint: "b".repeat(64),
      }),
    ).toBe(false);
  });
});
