import { constants, publicEncrypt } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  directory: "",
  configured: false,
  configure: vi.fn(),
  post: vi.fn(),
  get: vi.fn(),
  flush: vi.fn(),
  discovery: vi.fn(),
  bearer: [] as string[],
  exchange: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("../client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client.js")>()),
  getSiteUrl: () => "https://api.example.com",
  getPinnedClient: async () => ({
    post: mocks.post,
    get: mocks.get,
  }),
  getBearerClient: (token: string) => {
    mocks.bearer.push(token);
    return { post: mocks.post, get: mocks.get };
  },
}));
vi.mock("../flusher.js", () => ({ flush: mocks.flush }));
vi.mock("../journal.js", () => ({ listBuckets: () => [] }));
vi.mock("../journal-organization.js", () => ({
  classifyJournalBuckets: () => ({ retainedBuckets: [] }),
}));
vi.mock("./paths.js", () => ({ primConfigDirectory: () => mocks.directory }));
vi.mock("./machine-credentials.js", () => ({
  prepareMachineMetadataDirectory: (directory: string) => mkdirSync(directory, { recursive: true }),
  writeMachineMetadata: (path: string, value: unknown) =>
    writeFileSync(path, JSON.stringify(value)),
  hasMachineConfiguration: () => mocks.configured,
  configureMachine: mocks.configure,
  acquireMachineCredential: async () => ({
    authorizedUserId: "alex",
    organizationId: "org",
    machineId: "laptop",
    storage: "keychain",
  }),
}));
vi.mock("./machine-protocol.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./machine-protocol.js")>()),
  discoverMachineConfiguration: mocks.discovery,
  exchangeMachineCredentials: mocks.exchange,
  verifyMachineIdentity: mocks.verify,
}));
import { readdirSync } from "node:fs";
import { HttpError } from "../client.js";
import {
  ENROLLMENT_KIND_FIELD,
  enrollDeveloperInstallation,
  enrollEnvironmentInstallation,
  enrollOrganizationEnvironment,
  installationEnvironment,
  prepareEnvironmentEnrollment,
} from "./developer-enrollment.js";
import { parseMachineIdentity } from "./machine-protocol.js";

beforeEach(() => {
  mocks.directory = mkdtempSync(join(tmpdir(), "prim-enrollment-"));
  mocks.configured = false;
  vi.clearAllMocks();
  mocks.get.mockResolvedValue({ userId: "alex", organizationId: "org" });
  mocks.discovery.mockResolvedValue({
    issuer: "https://auth.example.com",
    audience: "client_env",
    developerEnrollment: true,
  });
  mocks.configure.mockImplementation(async () => {
    mocks.configured = true;
    return {
      machineId: "laptop",
      authorizedUserId: "alex",
      organizationId: "org",
      storage: "keychain",
    };
  });
  vi.stubEnv("PRIM_TOKEN", "");
  mocks.bearer.length = 0;
  mocks.exchange.mockResolvedValue({
    accessToken: "machine-access",
    expiresAt: Date.now() + 60_000,
  });
  mocks.verify.mockResolvedValue({
    machineId: "cloud",
    authorizedUserId: "alex",
    clientId: "client_cloud",
    displayName: "Claude Code cloud",
    organizationId: "org",
    workosOrganizationId: "org_workos",
    scopes: ["cli:read"],
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(mocks.directory, { recursive: true, force: true });
});

describe("developer enrollment", () => {
  it("delivers a one-time encrypted secret and reuses the installation on repeated setup", async () => {
    let ciphertext = "";
    mocks.post.mockImplementation(async (path, body) => {
      if (path.endsWith("/start")) {
        expect(body.userId).toBeUndefined();
        expect(body.authorizedUserId).toBeUndefined();
        expect(body.challenge).toMatch(/^[a-f0-9]{64}$/u);
        ciphertext = publicEncrypt(
          { key: body.publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
          Buffer.from("one-time-workos-secret"),
        ).toString("base64");
        return { enrollmentId: "enrollment" };
      }
      if (path.endsWith("/activate")) return { activated: true };
      return {
        ciphertext,
        clientId: "client_laptop",
        machineId: "laptop",
        authorizedUserId: "alex",
      };
    });
    const result = await enrollDeveloperInstallation();
    expect(mocks.configure).toHaveBeenCalledWith("client_laptop", "one-time-workos-secret", {
      expectedAuthorizedUserId: "alex",
      expectedOrganizationId: "org",
    });
    expect(JSON.stringify(result)).not.toContain("secret");
    expect(result.authorizedUserId).toBe("alex");
    expect((await enrollDeveloperInstallation()).reused).toBe(true);
    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(mocks.post).toHaveBeenCalledWith(
      "/api/cli/auth/enrollment/activate",
      { enrollmentId: "enrollment" },
      expect.any(Object),
    );
  });
  it("preserves credentials when the exchange cannot be decrypted", async () => {
    mocks.post.mockImplementation(async (path) =>
      path.endsWith("/start")
        ? { enrollmentId: "enrollment" }
        : {
            ciphertext: "invalid",
            clientId: "client_laptop",
            machineId: "laptop",
            authorizedUserId: "alex",
          },
    );
    await expect(enrollDeveloperInstallation()).rejects.toMatchObject({
      code: "invalid_enrollment",
    });
    expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("retries secret retirement without provisioning another installation", async () => {
    let ciphertext = "";
    let activations = 0;
    mocks.post.mockImplementation(async (path, body) => {
      if (path.endsWith("/start")) {
        ciphertext = publicEncrypt(
          { key: body.publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
          Buffer.from("one-time-workos-secret"),
        ).toString("base64");
        return { enrollmentId: "enrollment" };
      }
      if (path.endsWith("/activate")) {
        if (++activations === 1) throw new Error("temporary outage");
        return { activated: true };
      }
      return {
        ciphertext,
        clientId: "client_laptop",
        machineId: "laptop",
        authorizedUserId: "alex",
      };
    });
    expect(await enrollDeveloperInstallation()).toMatchObject({ activationPending: true });
    expect(await enrollDeveloperInstallation()).toMatchObject({
      reused: true,
      activationPending: false,
    });
    expect(mocks.configure).toHaveBeenCalledTimes(1);
    expect(activations).toBe(2);
    await enrollDeveloperInstallation();
    expect(activations).toBe(2);
  });
  it.each([401, 403])("requires human sign-in when bootstrap returns %i", async (status) => {
    mocks.get.mockRejectedValueOnce(new HttpError(status, "Human consent required"));
    await expect(enrollDeveloperInstallation()).rejects.toMatchObject({
      code: "human_sign_in_required",
    });
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.configure).not.toHaveBeenCalled();
  });
  it("retains legacy auth on servers without enrollment and fails explicit enrollment", async () => {
    mocks.discovery.mockResolvedValue({
      issuer: "https://auth.example.com",
      audience: "client_env",
    });
    expect(await enrollDeveloperInstallation(true)).toEqual({
      enrolled: false,
      reason: "server_enrollment_unavailable",
    });
    await expect(enrollDeveloperInstallation()).rejects.toMatchObject({
      code: "enrollment_unavailable",
    });
    expect(mocks.post).not.toHaveBeenCalled();
  });
});

it("requires a versioned user binding and refuses ambiguous machine ownership", () => {
  const status = {
    authenticated: true,
    organizationBindingVersion: 3,
    captureAuthorityKind: "workos_m2m",
    organizationId: "org",
    workosOrganizationId: "org_workos",
    principal: {
      kind: "machine",
      clientId: "client_laptop",
      machineId: "laptop",
      displayName: "Laptop",
      scopes: [],
      authorizedUserId: "alex",
    },
  };
  expect(parseMachineIdentity(status, "client_laptop").authorizedUserId).toBe("alex");
  expect(() =>
    parseMachineIdentity({ ...status, organizationBindingVersion: 2 }, "client_laptop"),
  ).toThrow();
  expect(() =>
    parseMachineIdentity(
      { ...status, principal: { ...status.principal, authorizedUserId: undefined } },
      "client_laptop",
    ),
  ).toThrow();
});

describe("environment installation enrollment", () => {
  function serveEnrollment(secret = "cloud-secret") {
    const starts: Record<string, unknown>[] = [];
    let ciphertext = "";
    mocks.post.mockImplementation(async (path, body) => {
      if (path.endsWith("/start")) {
        starts.push(body);
        ciphertext = publicEncrypt(
          { key: body.publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
          Buffer.from(secret),
        ).toString("base64");
        return { enrollmentId: "enrollment" };
      }
      if (path.endsWith("/redeem"))
        return {
          ciphertext,
          clientId: "client_cloud",
          machineId: "cloud",
          authorizedUserId: "alex",
        };
      throw new Error(`unexpected ${path}`);
    });
    return starts;
  }

  const enroll = async (name = "cloud", token = "human-jwt") =>
    enrollEnvironmentInstallation(await prepareEnvironmentEnrollment(name), token);

  it("mints a named, separate installation under the given human session and stores nothing", async () => {
    mocks.configured = true; // this machine is already enrolled; it must stay untouched
    const starts = serveEnrollment();
    const installation = await enroll("  Claude Code cloud ");
    expect(installation).toEqual({
      environment: [
        "PRIM_M2M_CLIENT_ID=client_cloud",
        "PRIM_M2M_CLIENT_SECRET=cloud-secret",
        "PRIM_API_URL=https://api.example.com",
      ],
      displayName: "Claude Code cloud",
      clientId: "client_cloud",
      clientSecret: "cloud-secret",
      machineId: "cloud",
      authorizedUserId: "alex",
      organizationId: "org",
    });
    expect(mocks.bearer).toEqual(["human-jwt"]);
    expect(starts[0]).toMatchObject({ displayName: "Claude Code cloud" });
    expect(starts[0]?.installationId).toMatch(/^[a-f0-9-]{36}$/u);
    expect(mocks.exchange).toHaveBeenCalledWith(expect.any(Object), "client_cloud", "cloud-secret");
    expect(mocks.verify).toHaveBeenCalledWith(
      "https://api.example.com",
      "machine-access",
      "client_cloud",
    );
    expect(mocks.configure).not.toHaveBeenCalled();
    expect(mocks.flush).not.toHaveBeenCalled();
    expect(mocks.post).not.toHaveBeenCalledWith(
      "/api/cli/auth/enrollment/activate",
      expect.anything(),
      expect.anything(),
    );
    expect(readdirSync(mocks.directory)).toEqual([]);
  });

  it.each([
    ["is not delegated", { authorizedUserId: undefined }],
    ["belongs to another organization", { organizationId: "other-org" }],
    ["is a different machine than the one redeemed", { machineId: "elsewhere" }],
  ])("rejects a credential that %s and names the installation to revoke", async (_label, patch) => {
    serveEnrollment();
    mocks.verify.mockResolvedValue({
      machineId: "cloud",
      authorizedUserId: "alex",
      clientId: "client_cloud",
      displayName: "cloud",
      organizationId: "org",
      workosOrganizationId: "org_workos",
      scopes: ["cli:read"],
      ...patch,
    });
    const error = await enroll().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "delegation_mismatch" });
    expect((error as Error).message).toMatch(/Installation "cloud" was already registered/u);
  });

  it("names the registered installation when the token exchange fails after redeem", async () => {
    serveEnrollment();
    mocks.exchange.mockRejectedValue(new Error("socket hang up"));
    const error = await enroll().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "enrollment_failed" });
    expect((error as Error).message).toMatch(/revoke it in Settings/u);
  });

  it("names the installation when the minted secret cannot be written as .env", async () => {
    serveEnrollment("has space");
    const error = await enroll().catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_credentials" });
    expect((error as Error).message).toMatch(/Installation "cloud" was already registered/u);
  });

  it.each([
    ["is lost", new TypeError("fetch failed")],
    ["fails at a gateway", new HttpError(502, "bad gateway")],
  ])(
    "warns that a /start response that %s may have registered the installation",
    async (_label, failure) => {
      mocks.post.mockRejectedValue(failure);
      const error = await enroll().catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: "enrollment_failed" });
      expect((error as Error).message).toMatch(/may have been registered/u);
    },
  );

  it("does not claim an installation exists when the start is refused", async () => {
    mocks.post.mockRejectedValue(new HttpError(403, "installation_limit_reached"));
    const error = await enroll().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpError);
  });

  it("rejects a redeem authorized for someone else", async () => {
    serveEnrollment();
    const served = mocks.post.getMockImplementation();
    mocks.post.mockImplementation(async (path: string, body: unknown) => {
      const response = await served?.(path, body);
      return path.endsWith("/redeem") ? { ...response, authorizedUserId: "mallory" } : response;
    });
    await expect(enroll()).rejects.toMatchObject({ code: "invalid_enrollment" });
    expect(mocks.exchange).not.toHaveBeenCalled();
  });

  it("explains a rejected session without pointing at prim auth login", async () => {
    mocks.get.mockRejectedValue(new HttpError(403, "human_sign_in_required"));
    const error = await enroll("cloud", "machine-token").catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "human_sign_in_required" });
    expect((error as Error).message).not.toMatch(/prim auth login/u);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("keeps the local sign-in hint for this machine's own enrollment", async () => {
    mocks.get.mockRejectedValue(new HttpError(401, "human_sign_in_required"));
    await expect(enrollDeveloperInstallation()).rejects.toMatchObject({
      code: "human_sign_in_required",
      message: "Sign in once with prim auth login to authorize this developer installation.",
    });
  });

  it.each(["not a url", "https://api.example.com/path", "http://[::1]:3210"])(
    "refuses the deployment %j before discovery",
    async (url) => {
      const client = await import("../client.js");
      const siteUrl = vi.spyOn(client, "getSiteUrl").mockReturnValue(url);
      try {
        await expect(prepareEnvironmentEnrollment("cloud")).rejects.toMatchObject({
          code: "invalid_configuration",
        });
        expect(mocks.discovery).not.toHaveBeenCalled();
      } finally {
        siteUrl.mockRestore();
      }
    },
  );

  it("refuses before any sign-in when the server has enrollment disabled", async () => {
    mocks.discovery.mockResolvedValue({
      issuer: "https://auth.example.com",
      audience: "client_env",
      developerEnrollment: false,
    });
    await expect(prepareEnvironmentEnrollment("cloud")).rejects.toMatchObject({
      code: "enrollment_unavailable",
    });
  });

  it.each(["", "   ", "x".repeat(129), "bad\u0007name", "c1\u0085name", "zero\u200bwidth"])(
    "rejects the name %j before discovery",
    async (name) => {
      await expect(prepareEnvironmentEnrollment(name)).rejects.toMatchObject({
        code: "invalid_installation_name",
      });
      expect(mocks.discovery).not.toHaveBeenCalled();
    },
  );
});

describe("installationEnvironment", () => {
  const credential = { clientId: "client_01ABC", clientSecret: "s3cr3t.~+/=-_" };

  it("writes bare .env lines for the default deployment", () => {
    expect(installationEnvironment(credential, "https://api.getprimitive.ai")).toEqual([
      "PRIM_M2M_CLIENT_ID=client_01ABC",
      "PRIM_M2M_CLIENT_SECRET=s3cr3t.~+/=-_",
    ]);
  });

  it("carries a non-default deployment with the credential", () => {
    expect(installationEnvironment(credential, "http://localhost:3210")).toContain(
      "PRIM_API_URL=http://localhost:3210",
    );
  });

  it.each(["", "has space", "hash#tail", "it's", "line\nbreak", "caf\u00e9", "del\u007f"])(
    "refuses a value it cannot write bare: %j",
    (clientSecret) => {
      expect(() =>
        installationEnvironment({ ...credential, clientSecret }, "https://api.getprimitive.ai"),
      ).toThrow(/cannot be written/u);
    },
  );
});

describe("organization environment credential enrollment", () => {
  // The server's environment redeem; an installation's names its user instead.
  const environmentRedeem = {
    kind: "environment",
    organizationId: "org",
    scopes: ["cli:session-identity"],
  };
  function serveEnvironment(
    redeem: Record<string, unknown> = {},
    shape: Record<string, unknown> = environmentRedeem,
  ) {
    const starts: Record<string, unknown>[] = [];
    let ciphertext = "";
    mocks.post.mockImplementation(async (path, body) => {
      if (path.endsWith("/start")) {
        starts.push(body);
        ciphertext = publicEncrypt(
          { key: body.publicKey, oaepHash: "sha256", padding: constants.RSA_PKCS1_OAEP_PADDING },
          Buffer.from("environment-secret"),
        ).toString("base64");
        return { enrollmentId: "enrollment" };
      }
      if (path.endsWith("/redeem"))
        return {
          ciphertext,
          clientId: "client_env",
          machineId: "env",
          ...shape,
          ...redeem,
        };
      throw new Error(`unexpected ${path}`);
    });
    return starts;
  }
  const organizationLevel = {
    machineId: "env",
    clientId: "client_env",
    displayName: "Team cloud",
    organizationId: "org",
    workosOrganizationId: "org_workos",
    scopes: ["cli:session-identity"],
  };

  it("asks for the environment kind and prints the session identity line", async () => {
    const starts = serveEnvironment();
    mocks.verify.mockResolvedValue(organizationLevel);
    const credential = await enrollOrganizationEnvironment(
      await prepareEnvironmentEnrollment("Team cloud"),
      "admin-jwt",
    );
    expect(starts[0]).toMatchObject({ [ENROLLMENT_KIND_FIELD]: "environment" });
    expect(credential.environment).toEqual([
      "PRIM_M2M_CLIENT_ID=client_env",
      "PRIM_M2M_CLIENT_SECRET=environment-secret",
      "PRIM_API_URL=https://api.example.com",
      "PRIM_CLOUD_IDENTITY=session",
    ]);
    expect(mocks.bearer).toEqual(["admin-jwt"]);
    expect(readdirSync(mocks.directory)).toEqual([]);
  });

  it("leaves the --new-installation request without a kind", async () => {
    const starts = serveEnvironment(
      { authorizedUserId: "alex", clientId: "client_cloud", machineId: "cloud" },
      {},
    );
    await enrollEnvironmentInstallation(await prepareEnvironmentEnrollment("cloud"), "human-jwt");
    expect(starts[0]).not.toHaveProperty(ENROLLMENT_KIND_FIELD);
  });

  it.each([
    ["is not an environment", { kind: "installation" }],
    ["names no kind", { kind: undefined }],
    ["grants more than session identity", { scopes: ["cli:session-identity", "cli:read"] }],
    ["grants another scope", { scopes: ["cli:read"] }],
    ["names no scopes", { scopes: undefined }],
    ["is delegated to someone", { authorizedUserId: "alex" }],
  ])("refuses a redeem that %s before printing anything", async (_name, redeem) => {
    serveEnvironment(redeem);
    mocks.verify.mockResolvedValue(organizationLevel);
    const error = await enrollOrganizationEnvironment(
      await prepareEnvironmentEnrollment("Team cloud"),
      "admin-jwt",
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "invalid_enrollment" });
    expect((error as Error).message).toMatch(
      /Environment credential "Team cloud" was already registered/u,
    );
    expect(String((error as Error).message)).not.toContain("environment-secret");
    expect(mocks.verify).not.toHaveBeenCalled();
  });

  it("refuses a credential delegated to the admin and names it for revocation", async () => {
    serveEnvironment();
    mocks.verify.mockResolvedValue({ ...organizationLevel, authorizedUserId: "alex" });
    const error = await enrollOrganizationEnvironment(
      await prepareEnvironmentEnrollment("Team cloud"),
      "admin-jwt",
    ).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "delegation_mismatch" });
    expect((error as Error).message).toMatch(
      /Environment credential "Team cloud" was already registered/u,
    );
  });
});
