import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { HttpError, getClient, getPinnedClient } from "./client.js";
import { acquireMachineCredential, forwardMachineRequest } from "./lib/machine-credentials.js";
import { MachineAuthError } from "./lib/machine-protocol.js";

// A credential whose token the cloud environment's proxy holds: prim has none.
const machine = vi.hoisted(() => ({
  issuer: "https://auth.example.com",
  audience: "client_environment",
  apiUrl: "https://api.example.com",
  clientId: "client_installation",
  machineId: "machine_one",
  organizationId: "organization_one",
  workosOrganizationId: "org_one",
  displayName: "Claude Code cloud",
  scopes: ["cli:read"],
  generation: "generation_one",
  accessToken: "",
  expiresAt: Date.now() + 3_600_000,
  storage: "environment" as const,
  tokenInjection: "network" as const,
}));
vi.mock("./lib/machine-credentials.js", () => ({
  hasMachineConfiguration: () => true,
  machineContext: () => ({ ...machine }),
  cachedMachineCredential: () => ({ ...machine }),
  machineSessionEnded: () => false,
  acquireMachineCredential: vi.fn(async () => ({ ...machine })),
  forwardMachineRequest: vi.fn(),
}));
vi.mock("./lib/ingest-uploader.js", () => ({
  ingestUploaderHeaders: async () => ({ "X-Prim-Uploader-Version": "1.2.3" }),
}));

const directFetch = vi.fn();
beforeEach(() => {
  vi.mocked(acquireMachineCredential).mockClear();
  vi.mocked(forwardMachineRequest).mockReset();
  directFetch.mockReset();
  // Any request prim made itself would bypass the proxy that holds the token.
  vi.stubGlobal("fetch", directFetch);
});
afterEach(() => vi.unstubAllGlobals());

it("sends every API request through the broker and none directly", async () => {
  vi.mocked(forwardMachineRequest).mockImplementation(async () => Response.json({ decisions: [] }));
  const client = getClient();
  expect(await client.get("/api/cli/decisions/recent")).toEqual({ decisions: [] });
  expect(await client.post("/api/cli/moves/ingest", { moves: [] })).toEqual({ decisions: [] });

  expect(directFetch).not.toHaveBeenCalled();
  const [read, upload] = vi.mocked(forwardMachineRequest).mock.calls.map(([request]) => request);
  expect(read).toEqual({
    method: "GET",
    path: "/api/cli/decisions/recent",
    headers: { "Content-Type": "application/json" },
  });
  expect(upload).toEqual({
    method: "POST",
    path: "/api/cli/moves/ingest",
    headers: { "Content-Type": "application/json", "X-Prim-Uploader-Version": "1.2.3" },
    body: '{"moves":[]}',
  });
  // No header of prim's own names a credential; the proxy attaches the token.
  expect(JSON.stringify([read, upload])).not.toMatch(/authorization|bearer/iu);
});

it("verifies again after a 401 and retries once through the broker", async () => {
  vi.mocked(forwardMachineRequest)
    .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ authenticated: true }));
  const client = await getPinnedClient();
  expect(await client.get("/api/cli/auth/status")).toEqual({ authenticated: true });
  expect(forwardMachineRequest).toHaveBeenCalledTimes(2);
  expect(vi.mocked(acquireMachineCredential).mock.calls.some(([options]) => options?.force)).toBe(
    true,
  );
  expect(directFetch).not.toHaveBeenCalled();
});

it("names the OAuth network secret when the API keeps refusing", async () => {
  vi.mocked(forwardMachineRequest).mockImplementation(async () =>
    Response.json({}, { status: 401 }),
  );
  const failure = await getClient()
    .get("/api/cli/decisions/recent")
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(HttpError);
  expect((failure as HttpError).status).toBe(401);
  expect((failure as HttpError).message).toContain("OAuth 2.0 client credentials network secret");
});

it("reports a broker failure as unavailable, not as a rejected credential", async () => {
  vi.mocked(forwardMachineRequest).mockRejectedValue(
    new MachineAuthError("broker_unavailable", "Machine credential broker is unavailable."),
  );
  const failure = await getClient()
    .get("/api/cli/decisions/recent")
    .catch((error: unknown) => error);
  expect(failure).toMatchObject({ status: 503, body: { error: "broker_unavailable" } });
});
