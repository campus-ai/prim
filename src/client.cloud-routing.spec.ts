import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { getClient, getPinnedClient, getPinnedManagementClient } from "./client.js";
import { acquireMachineCredential, forwardMachineRequest } from "./lib/machine-credentials.js";

// A cloud session's credential from its variables: prim holds the token, and
// its requests go through the broker to ride the environment's proxy. The
// broker attaches the token it holds; this process's copy is never sent.
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
  accessToken: "token_one",
  expiresAt: Date.now() + 3_600_000,
  storage: "environment" as const,
  routing: "proxy" as "proxy" | undefined,
}));
vi.mock("./lib/machine-credentials.js", () => ({
  hasMachineConfiguration: () => true,
  machineContext: () => ({ ...machine }),
  cachedMachineCredential: () => ({ ...machine }),
  machineSessionEnded: () => false,
  acquireMachineCredential: vi.fn(),
  forwardMachineRequest: vi.fn(),
}));
vi.mock("./lib/ingest-uploader.js", () => ({
  ingestUploaderHeaders: async () => ({ "X-Prim-Uploader-Version": "1.2.3" }),
}));

const directFetch = vi.fn();
beforeEach(() => {
  machine.accessToken = "token_one";
  machine.routing = "proxy";
  vi.mocked(acquireMachineCredential).mockReset();
  vi.mocked(acquireMachineCredential).mockImplementation(async (options) => {
    if (options?.force) machine.accessToken = "token_renewed";
    return { ...machine };
  });
  vi.mocked(forwardMachineRequest).mockReset();
  directFetch.mockReset();
  // A request prim made itself would not ride the proxy: in a cloud VM it
  // resolves only the hosts allowed when the session was created.
  vi.stubGlobal("fetch", directFetch);
});
afterEach(() => vi.unstubAllGlobals());

it("sends every API request through the broker, none directly, and no credential with any", async () => {
  vi.mocked(forwardMachineRequest).mockImplementation(async () => Response.json({ decisions: [] }));
  const client = getClient();
  expect(await client.get("/api/cli/decisions/recent")).toEqual({ decisions: [] });
  expect(await client.post("/api/cli/moves/ingest", { moves: [] })).toEqual({ decisions: [] });
  const management = await getPinnedManagementClient();
  await management.delete("/api/cli/auth/api-keys/key_1");

  expect(directFetch).not.toHaveBeenCalled();
  const requests = vi.mocked(forwardMachineRequest).mock.calls.map(([request]) => request);
  const [read, upload, removal] = requests;
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
  expect(removal).toMatchObject({ method: "DELETE", path: "/api/cli/auth/api-keys/key_1" });
  // What answers on the broker's port is not yet known to be the broker
  // when the request is written: the token this process holds stays here.
  expect(JSON.stringify(requests)).not.toMatch(/authorization|bearer|token_one/iu);
});

it("renews after a 401 and retries through the broker, still sending no token", async () => {
  vi.mocked(forwardMachineRequest)
    .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({ authenticated: true }));
  const client = await getPinnedClient();
  expect(await client.get("/api/cli/auth/status")).toEqual({ authenticated: true });
  expect(forwardMachineRequest).toHaveBeenCalledTimes(2);
  // The broker renews its own token when this process reports the old one refused.
  expect(vi.mocked(acquireMachineCredential).mock.calls.some(([options]) => options?.force)).toBe(
    true,
  );
  expect(JSON.stringify(vi.mocked(forwardMachineRequest).mock.calls)).not.toMatch(
    /authorization|bearer|token_one|token_renewed/iu,
  );
  expect(directFetch).not.toHaveBeenCalled();
});

it("names the environment's credentials, not a network secret, when the API keeps refusing", async () => {
  vi.stubEnv("CLAUDE_CODE_REMOTE", "true");
  try {
    vi.mocked(forwardMachineRequest).mockImplementation(async () =>
      Response.json({}, { status: 401 }),
    );
    const failure = await getClient()
      .get("/api/cli/decisions/recent")
      .catch((error: unknown) => error);
    expect(failure).toMatchObject({ status: 401 });
    expect((failure as Error).message).toContain(
      "The cloud environment's credentials were rejected",
    );
    expect((failure as Error).message).not.toContain("network secret");
  } finally {
    vi.unstubAllEnvs();
  }
});

it("connects directly, token and all, where the credential is not relayed", async () => {
  // The same credential outside a cloud session, or with no proxy configured.
  machine.routing = undefined;
  directFetch.mockResolvedValue(Response.json({ decisions: [] }));
  expect(await getClient().get("/api/cli/decisions/recent")).toEqual({ decisions: [] });
  expect(forwardMachineRequest).not.toHaveBeenCalled();
  expect(directFetch).toHaveBeenCalledExactlyOnceWith(
    "https://api.example.com/api/cli/decisions/recent",
    expect.objectContaining({
      method: "GET",
      headers: { Authorization: "Bearer token_one", "Content-Type": "application/json" },
      redirect: "error",
    }),
  );
});
