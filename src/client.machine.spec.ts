import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getPinnedClient } from "./client.js";
import { daemonPrincipalsMatch, resolveDaemonPrincipal } from "./daemon/principal.js";
import { acquireMachineCredential } from "./lib/machine-credentials.js";

const machine = vi.hoisted(() => ({
  issuer: "https://auth.example.com",
  audience: "client_environment",
  apiUrl: "https://api.example.com",
  clientId: "client_installation",
  machineId: "machine_one",
  organizationId: "organization_one",
  workosOrganizationId: "org_one",
  displayName: "Build runner",
  scopes: ["cli:read"],
  generation: "generation_one",
  accessToken: "token_one",
  expiresAt: Date.now() + 3_600_000,
  storage: "keychain" as const,
}));
vi.mock("./lib/machine-credentials.js", () => ({
  hasMachineConfiguration: () => true,
  machineContext: () => ({ ...machine }),
  cachedMachineCredential: () => ({ ...machine }),
  machineSessionEnded: () => false,
  acquireMachineCredential: vi.fn(async () => ({ ...machine })),
}));

beforeEach(() => {
  machine.generation = "generation_one";
  machine.accessToken = "token_one";
  vi.mocked(acquireMachineCredential).mockReset();
  vi.mocked(acquireMachineCredential).mockImplementation(async (options) => {
    if (options?.force) machine.accessToken = "token_renewed";
    return { ...machine };
  });
});
afterEach(() => vi.unstubAllGlobals());

it("renews a pinned machine request without changing its daemon principal", async () => {
  const principal = resolveDaemonPrincipal();
  const fetcher = vi
    .fn()
    .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ authenticated: true }));
  vi.stubGlobal("fetch", fetcher);
  const client = await getPinnedClient();
  expect(await client.get("/api/cli/auth/status")).toEqual({ authenticated: true });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(fetcher.mock.calls[1][1]).toMatchObject({
    headers: { Authorization: "Bearer token_renewed" },
    redirect: "error",
  });
  expect(daemonPrincipalsMatch(principal, resolveDaemonPrincipal())).toBe(true);
});

it("invalidates pinned work and daemon identity when configured credentials change", async () => {
  const principal = resolveDaemonPrincipal();
  const client = await getPinnedClient();
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  machine.generation = "generation_two";
  await expect(client.get("/api/cli/auth/status")).rejects.toMatchObject({ status: 409 });
  expect(fetcher).not.toHaveBeenCalled();
  expect(daemonPrincipalsMatch(principal, resolveDaemonPrincipal())).toBe(false);
});

it("does not replay a failed request under another organization", async () => {
  const fetcher = vi.fn().mockResolvedValue(Response.json({}, { status: 401 }));
  vi.stubGlobal("fetch", fetcher);
  vi.mocked(acquireMachineCredential).mockImplementation(async (options) => ({
    ...machine,
    organizationId: options?.force ? "organization_other" : machine.organizationId,
  }));
  const client = await getPinnedClient();
  await expect(client.get("/api/cli/auth/status")).rejects.toMatchObject({ status: 409 });
  expect(fetcher).toHaveBeenCalledTimes(1);
});
