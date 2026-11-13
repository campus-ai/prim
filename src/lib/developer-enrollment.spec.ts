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
}));
vi.mock("../client.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../client.js")>()),
  getSiteUrl: () => "https://api.example.com",
  getPinnedClient: async () => ({
    post: mocks.post,
    get: mocks.get,
  }),
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
}));
import { HttpError } from "../client.js";
import { enrollDeveloperInstallation } from "./developer-enrollment.js";
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
