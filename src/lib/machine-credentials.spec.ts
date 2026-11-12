import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type MachineDependencies,
  acquireMachineCredential,
  clearMachineCredentials,
  configureMachine,
  hasMachineConfiguration,
  machineSessionEnded,
  readMachineProfile,
} from "./machine-credentials.js";
import { exchangeMachineCredentials } from "./machine-protocol.js";

const configuration = { issuer: "https://auth.example.com", audience: "client_environment" };
const secret = "test-machine-secret";
let directory: string;
let tokens: number;
let tokenStatus: number;
let verificationStatus: number;
let deps: MachineDependencies;
let keychain: Map<string, string>;
const clientId = "client_installation";
function token(audience = configuration.audience): string {
  return `header.${Buffer.from(JSON.stringify({ iss: configuration.issuer, aud: audience, sub: clientId, client_id: clientId, org_id: "org_workos", exp: Math.floor(Date.now() / 1000) + 3600 })).toString("base64url")}.signature_${tokens}`;
}
function status() {
  return {
    authenticated: true,
    organizationBindingVersion: 2,
    captureAuthorityKind: "workos_m2m",
    organizationId: "organization_local",
    workosOrganizationId: "org_workos",
    principal: {
      kind: "machine",
      machineId: "machine_local",
      clientId,
      displayName: "Build runner",
      scopes: ["cli:read", "cli:capture"],
    },
  };
}
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "prim-machine-"));
  tokens = 0;
  tokenStatus = 200;
  verificationStatus = 200;
  keychain = new Map();
  deps = {
    directory,
    env: { PRIM_API_URL: "https://api.example.com" },
    entry: (key) => ({
      getPassword: async () => keychain.get(key) ?? null,
      setPassword: async (value) => {
        keychain.set(key, value);
      },
      deletePassword: async () => {
        keychain.delete(key);
      },
    }),
    fetch: vi.fn(async (url, options) => {
      expect(options?.redirect).toBe("error");
      if (String(url).endsWith("/m2m/config"))
        return Response.json({ protocol_version: 1, ...configuration });
      if (String(url).endsWith("/oauth2/token")) {
        tokens++;
        expect(String(options?.body)).toContain("grant_type=client_credentials");
        return tokenStatus === 200
          ? Response.json({ access_token: token(), token_type: "bearer", expires_in: 3600 })
          : Response.json({ error_description: secret }, { status: tokenStatus });
      }
      return Response.json(status(), { status: verificationStatus });
    }),
  };
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(directory, { recursive: true, force: true });
});

describe("machine credentials", () => {
  it("shares Retry-After across fresh processes and credential rotation", async () => {
    await configureMachine(clientId, secret, deps);
    let attempts = 0;
    const now = Date.now();
    const fetcher = deps.fetch;
    if (!fetcher) throw new Error("missing fixture fetch");
    deps.fetch = async (url, options) => {
      if (String(url).endsWith("/oauth2/token")) {
        attempts++;
        return Response.json(
          { error_description: secret },
          {
            status: 429,
            headers: { "Retry-After": "120" },
          },
        );
      }
      return fetcher(url, options);
    };
    await expect(acquireMachineCredential({ force: true }, deps)).rejects.toMatchObject({
      code: "token_service_unavailable",
      terminal: false,
      retryAt: expect.any(Number),
    });
    vi.resetModules();
    const fresh = await import("./machine-credentials.js");
    await expect(fresh.acquireMachineCredential({ force: true }, deps)).rejects.toMatchObject({
      code: "token_service_unavailable",
    });
    await expect(
      fresh.configureMachine(clientId, "replacement-secret", deps),
    ).rejects.toMatchObject({
      code: "token_service_unavailable",
    });
    expect(attempts).toBe(1);
    vi.spyOn(Date, "now").mockReturnValue(now + 121_000);
    await expect(fresh.acquireMachineCredential({ force: true }, deps)).rejects.toMatchObject({
      code: "token_service_unavailable",
    });
    expect(attempts).toBe(2);
    // Windows applies owner-only ACLs through several process launches here.
    // The fake-clock retry assertions above remain independent of runner speed.
  }, 15_000);

  it("preserves HTTP-date retry timing and ignores invalid retry metadata", async () => {
    const retry = new Date(Date.now() + 120_000).toUTCString();
    await expect(
      exchangeMachineCredentials(
        configuration,
        clientId,
        secret,
        undefined,
        async () => new Response(null, { status: 429, headers: { "Retry-After": retry } }),
      ),
    ).rejects.toMatchObject({ retryAt: Date.parse(retry) });
    await expect(
      exchangeMachineCredentials(
        configuration,
        clientId,
        secret,
        undefined,
        async () => new Response(null, { status: 429, headers: { "Retry-After": "invalid" } }),
      ),
    ).rejects.toMatchObject({ retryAt: undefined, terminal: false });
  });
  it("verifies both exchange and protected identity before activating keychain credentials", async () => {
    const profile = await configureMachine(clientId, secret, deps);
    expect(profile.storage).toBe("keychain");
    expect(readFileSync(join(directory, "machine_profile.json"), "utf8")).not.toContain(secret);
    expect(keychain.size).toBe(1);
    expect((await acquireMachineCredential({}, deps))?.machineId).toBe("machine_local");
    expect(tokens).toBe(1);
  });
  it("does not activate credentials rejected by the API", async () => {
    verificationStatus = 403;
    await expect(configureMachine(clientId, secret, deps)).rejects.toMatchObject({
      code: "machine_access_rejected",
    });
    expect(readMachineProfile(deps)).toBeUndefined();
    expect(keychain.size).toBe(0);
  });
  it("falls back to owner-only files when persistent OS storage is unavailable", async () => {
    deps.entry = () => {
      throw new Error("no persistent store");
    };
    const profile = await configureMachine(clientId, secret, deps);
    expect(profile.storage).toBe("file");
    if (process.platform !== "win32") {
      expect(statSync(directory).mode & 0o777).toBe(0o700);
      expect(statSync(join(directory, `machine_${profile.generation}.json`)).mode & 0o777).toBe(
        0o600,
      );
    } else {
      for (const path of [directory, join(directory, `machine_${profile.generation}.json`)]) {
        const encodedPath = Buffer.from(path).toString("base64");
        const script = `$ErrorActionPreference = 'Stop'; $p = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encodedPath}')); $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User; $acl = [System.IO.${path === directory ? "Directory" : "File"}]::GetAccessControl($p); $rules = @($acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])); if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([System.Security.Principal.SecurityIdentifier]) -ne $sid -or $rules.Count -ne 1 -or $rules[0].IdentityReference -ne $sid -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne 'FullControl') { throw 'Credential ACL is not owner-only' }`;
        execFileSync(
          "powershell.exe",
          [
            "-NoProfile",
            "-NonInteractive",
            "-EncodedCommand",
            Buffer.from(script, "utf16le").toString("base64"),
          ],
          { stdio: "pipe", windowsHide: true },
        );
      }
    }
    expect((await acquireMachineCredential({}, deps))?.storage).toBe("file");
  });
  it("fails explicitly if the selected keychain is locked", async () => {
    await configureMachine(clientId, secret, deps);
    deps.entry = () => {
      throw new Error("locked");
    };
    await expect(acquireMachineCredential({}, deps)).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect(readMachineProfile(deps)?.storage).toBe("keychain");
  });
  it("rejects credentials for a different deployment", async () => {
    await configureMachine(clientId, secret, deps);
    deps.env = { PRIM_API_URL: "https://other.example.com" };
    await expect(acquireMachineCredential({}, deps)).rejects.toMatchObject({
      code: "deployment_mismatch",
    });
  });
  it("keeps the active credential usable when retired cleanup is locked", async () => {
    const previous = await configureMachine(clientId, secret, deps);
    const originalEntry = deps.entry;
    if (!originalEntry) throw new Error("Missing test keychain");
    let locked = true;
    deps.entry = (key) => ({
      ...originalEntry(key),
      deletePassword: async (signal) => {
        if (locked && key.includes(previous.generation)) throw new Error("locked");
        await originalEntry(key).deletePassword(signal);
      },
    });
    const current = await configureMachine(clientId, "rotated-secret", deps);
    expect(current.generation).not.toBe(previous.generation);
    expect(keychain.size).toBe(2);
    await expect(clearMachineCredentials(deps)).rejects.toMatchObject({
      code: "storage_unavailable",
    });
    expect((await acquireMachineCredential({}, deps))?.generation).toBe(current.generation);
    locked = false;
    expect(await clearMachineCredentials(deps)).toBe(true);
    expect(readMachineProfile(deps)).toBeUndefined();
    expect(keychain.size).toBe(0);
  });
  it("can clear a profile whose keychain entry was already removed", async () => {
    await configureMachine(clientId, secret, deps);
    keychain.clear();
    expect(await clearMachineCredentials(deps)).toBe(true);
    expect(readMachineProfile(deps)).toBeUndefined();
  });
  it("requires complete, unambiguous injected credentials", () => {
    expect(() =>
      hasMachineConfiguration({ ...deps, env: { PRIM_M2M_CLIENT_ID: clientId } }),
    ).toThrow("Set both");
    expect(() =>
      hasMachineConfiguration({
        ...deps,
        env: { PRIM_TOKEN: "legacy", PRIM_M2M_CLIENT_ID: clientId, PRIM_M2M_CLIENT_SECRET: secret },
      }),
    ).toThrow("Unset PRIM_TOKEN");
  });
  it("gives the environment precedence without persisting its credentials", async () => {
    await configureMachine(clientId, secret, deps);
    const saved = readFileSync(join(directory, "machine_profile.json"), "utf8");
    deps.env = {
      ...deps.env,
      PRIM_M2M_CLIENT_ID: clientId,
      PRIM_M2M_CLIENT_SECRET: "injected-only",
    };
    expect((await acquireMachineCredential({}, deps))?.storage).toBe("environment");
    expect(readFileSync(join(directory, "machine_profile.json"), "utf8")).toBe(saved);
    expect([...keychain.values()].join()).not.toContain("injected-only");
  });
  it("serializes renewal so concurrent callers use one new token", async () => {
    await configureMachine(clientId, secret, deps);
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 3_550_000);
    const credentials = await Promise.all(
      Array.from({ length: 4 }, () => acquireMachineCredential({}, deps)),
    );
    expect(new Set(credentials.map((value) => value?.accessToken)).size).toBe(1);
    expect(tokens).toBe(2);
  });
  it("shares only verified identity with fresh processes and binds it to the environment generation", async () => {
    deps.env = {
      ...deps.env,
      PRIM_M2M_CLIENT_ID: clientId,
      PRIM_M2M_CLIENT_SECRET: "injected-only",
    };
    const credential = await acquireMachineCredential({}, deps);
    vi.resetModules();
    const fresh = await import("./machine-credentials.js");
    expect(fresh.machineContext(deps)).toMatchObject({
      machineId: "machine_local",
      generation: credential?.generation,
    });
    expect(fresh.cachedMachineCredential(deps)).toBeUndefined();
    const files = readdirSync(directory);
    expect(files).toHaveLength(1);
    const metadata = readFileSync(join(directory, files[0]), "utf8");
    expect(metadata).not.toContain("injected-only");
    expect(metadata).not.toContain(credential?.accessToken);
    expect(metadata).not.toContain("accessToken");
    expect(metadata).not.toContain("clientSecret");
    expect(
      fresh.machineContext({ ...deps, env: { ...deps.env, PRIM_M2M_CLIENT_SECRET: "rotated" } }),
    ).toBeUndefined();
    expect(
      fresh.machineContext({
        ...deps,
        env: { ...deps.env, PRIM_API_URL: "https://other.example.com" },
      }),
    ).toBeUndefined();
    vi.spyOn(Date, "now").mockReturnValue((credential?.expiresAt ?? 0) + 1);
    expect(fresh.machineContext(deps)).toBeUndefined();
  });
  it("withdraws shared environment context after terminal rejection", async () => {
    deps.env = {
      ...deps.env,
      PRIM_M2M_CLIENT_ID: clientId,
      PRIM_M2M_CLIENT_SECRET: "rejected-injection",
    };
    await acquireMachineCredential({}, deps);
    tokenStatus = 401;
    await expect(acquireMachineCredential({ force: true }, deps)).rejects.toMatchObject({
      terminal: true,
    });
    vi.resetModules();
    const fresh = await import("./machine-credentials.js");
    expect(fresh.machineContext(deps)).toBeUndefined();
    expect(readdirSync(directory)).toEqual([]);
  });
  it("pauses terminal failures but retries temporary ones, with secret-free errors", async () => {
    await configureMachine(clientId, secret, deps);
    tokenStatus = 503;
    await expect(acquireMachineCredential({ force: true }, deps)).rejects.toMatchObject({
      code: "token_service_unavailable",
      terminal: false,
    });
    expect(machineSessionEnded(deps)).toBe(false);
    tokenStatus = 401;
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 120_000);
    await expect(acquireMachineCredential({ force: true }, deps)).rejects.toThrow(
      "Machine credentials were rejected",
    );
    expect(machineSessionEnded(deps)).toBe(true);
    const count = tokens;
    await expect(acquireMachineCredential({}, deps)).rejects.toMatchObject({ terminal: true });
    expect(tokens).toBe(count);
    expect(readFileSync(join(directory, "machine_terminal.json"), "utf8")).not.toContain(secret);
  });
  it("does not allow an insecure file profile", async () => {
    if (process.platform === "win32") return;
    await configureMachine(clientId, secret, deps);
    chmodSync(join(directory, "machine_profile.json"), 0o644);
    expect(() => readMachineProfile(deps)).toThrow("owner-only");
  });
  it("requires environment audience rather than the application client ID", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({ access_token: token(clientId), token_type: "bearer", expires_in: 3600 }),
    );
    await expect(
      exchangeMachineCredentials(configuration, clientId, secret, undefined, fetcher),
    ).rejects.toMatchObject({ code: "token_identity_mismatch" });
  });
  it("redacts network failures without treating them as invalid credentials", async () => {
    await expect(
      exchangeMachineCredentials(configuration, clientId, secret, undefined, async () => {
        throw new Error(`provider echoed ${secret}`);
      }),
    ).rejects.toMatchObject({
      code: "authentication_unavailable",
      terminal: false,
      message: "Machine authentication is temporarily unavailable. Check the connection and retry.",
    });
  });
  it("does not persist anything after cancellation", async () => {
    const controller = new AbortController();
    controller.abort();
    deps.fetch = async (_url, options) => {
      options?.signal?.throwIfAborted();
      throw new Error("unexpected request");
    };
    await expect(configureMachine(clientId, secret, deps, controller.signal)).rejects.toBeDefined();
    expect(readdirSync(directory)).toEqual([]);
  });
});
